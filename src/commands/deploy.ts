import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.js';
import type { Service } from '../api/types.js';
import { type FileSelection, collectFiles } from '../archive.js';
import { sleep } from '../approvals.js';
import { backupUnavailableReason, createBackup, waitForBackup } from '../backups.js';
import { requireClient } from '../context.js';
import { deployToGameService } from '../deploy/game.js';
import { checkVpsPath, deployToVps, rsyncExcludes, ssh, vpsTarget } from '../deploy/vps.js';
import { CliError, ExitCode } from '../errors.js';
import { LogFollower } from '../logs.js';
import { Spinner, colorState, confirm, err, formatBytes, info, isInteractive, print, step, success, warn } from '../output.js';
import { getState, sendPower } from '../power.js';
import { resolveService, serviceKind } from '../services.js';
import { remotePath } from '../transfer.js';

interface DeployOptions {
    service: string;
    path?: string;
    clean?: boolean;
    keep?: string;
    backup: boolean;
    restart: boolean;
    yes?: boolean;
    dryRun?: boolean;
    run?: string;
    sshKey?: string;
    follow: string;
}

function summarize(root: string, selection: FileSelection): void {
    info(`${err.bold(String(selection.files.length))} files, ${formatBytes(selection.totalBytes)} from ${root}`);
    if (selection.ignored.length > 0) {
        const shown = selection.ignored.slice(0, 6).join(', ');
        info(err.dim(`Ignored: ${shown}${selection.ignored.length > 6 ? `, … (${selection.ignored.length})` : ''}`));
    }
    if (selection.symlinks.length > 0) {
        warn(`${selection.symlinks.length} symbolic link(s) skipped: ${selection.symlinks.slice(0, 3).join(', ')}`);
    }
    if (selection.envFiles.length > 0) {
        warn(`${selection.envFiles.join(', ')} will be deployed (secrets). Add it to .aclignore to keep it local.`);
    }
}

async function confirmOrAbort(question: string, options: DeployOptions): Promise<void> {
    if (options.yes || !isInteractive()) {
        return;
    }
    if (!(await confirm(question, true))) {
        throw new CliError('Cancelled.', ExitCode.ERROR);
    }
}

/** Backup before deploying; when the offer does not allow one, explain and ask (or go on with --yes). */
async function backupFirst(client: ApiClient, service: Service, options: DeployOptions): Promise<void> {
    const spinner = new Spinner().start('Creating a backup before deploying…');
    try {
        const backup = await createBackup(client, service, `Before CLI deploy ${new Date().toISOString().slice(0, 16)}`);
        const done = await waitForBackup(client, service, backup.uuid);
        spinner.stop();
        if (!done.is_successful) {
            throw new CliError('The backup failed.', ExitCode.ERROR, 'Retry, or deploy without it with --no-backup.');
        }
        success(`Backup ${done.uuid.slice(0, 8)} created (${formatBytes(done.bytes)}).`);
    } catch (error) {
        spinner.stop();
        const reason = backupUnavailableReason(error);
        if (!reason) {
            throw error;
        }
        warn(`No backup: ${reason}`);
        if (options.yes) {
            return;
        }
        if (!isInteractive()) {
            throw new CliError('Deployment stopped: no backup could be created.', ExitCode.ERROR, 'Run again with --yes or --no-backup to deploy without a backup.');
        }
        if (!(await confirm('Deploy without a backup?'))) {
            throw new CliError('Cancelled.', ExitCode.ERROR);
        }
    }
}

async function restartAndWatch(client: ApiClient, service: Service, seconds: number): Promise<void> {
    const follower = new LogFollower(client, service);
    await follower.prime().catch(() => []);
    step(`Restarting ${service.name}…`);
    await sendPower(client, service, 'restart');

    for (let elapsed = 0; elapsed < seconds; elapsed += 2) {
        await sleep(2000);
        for (const line of await follower.poll().catch(() => [])) {
            print(`${err.dim('│')} ${line}`);
        }
    }

    const state = await getState(client, service).catch(() => 'unknown');
    if (state === 'running') {
        success(`${service.name} is ${colorState(state)}.`);
        return;
    }
    warn(`${service.name} is ${colorState(state)} after ${seconds} s.`);
    info(err.dim(`Follow it with \`aclclouds logs ${service.identifier} -f\`.`));
    process.exitCode = ExitCode.ERROR;
}

async function deployGame(client: ApiClient, service: Service, root: string, selection: FileSelection, options: DeployOptions) {
    const directory = remotePath(options.path ?? '/');
    const keep = (options.keep ?? '').split(',').map((name) => name.trim()).filter(Boolean);

    if (options.dryRun) {
        for (const file of selection.files) {
            print(`${file.path}  ${err.dim(formatBytes(file.size))}`);
        }
        info(err.dim(`Dry run: nothing sent. Target: ${service.name}:${directory}${options.clean ? ' (clean)' : ''}.`));
        return;
    }

    await confirmOrAbort(
        `Deploy to ${service.name}:${directory}${options.clean ? ` and REMOVE the files already there${keep.length ? ` (except ${keep.join(', ')})` : ''}` : ''}?`,
        options,
    );

    if (options.backup) {
        await backupFirst(client, service, options);
    }

    const spinner = new Spinner().start('Building the archive…');
    let result;
    try {
        result = await deployToGameService(
            client,
            service,
            root,
            selection,
            { directory, clean: Boolean(options.clean), keep },
            {
                onArchive: (bytes) => spinner.update(`Uploading ${formatBytes(bytes)}…`),
                onUploaded: () => spinner.update(options.clean ? 'Cleaning and extracting…' : 'Extracting…'),
            },
        );
    } finally {
        spinner.stop();
    }
    success(
        `Deployed to ${service.name}:${result.directory}${result.clean ? ` (${result.removed.length} old entries removed)` : ''}.`,
    );

    if (options.restart) {
        await restartAndWatch(client, service, Math.max(0, Number(options.follow) || 0));
    }
}

async function deployVps(service: Service, root: string, selection: FileSelection, options: DeployOptions) {
    const keep = (options.keep ?? '').split(',').map((name) => name.trim()).filter(Boolean);
    const path = checkVpsPath(options.path, Boolean(options.clean));
    const target = vpsTarget(service);
    const vpsOptions = { path, clean: Boolean(options.clean), keep, sshKey: options.sshKey };

    if (options.dryRun) {
        for (const file of selection.files) {
            print(`${file.path}  ${err.dim(formatBytes(file.size))}`);
        }
        info(err.dim(`Dry run: nothing sent. Target: ${target.user}@${target.host}:${path}${options.clean ? ' (rsync --delete)' : ''}.`));
        info(err.dim(`Excluded: ${rsyncExcludes(selection, vpsOptions).length} rule(s).`));
        return;
    }

    await confirmOrAbort(
        `Sync to ${target.user}@${target.host}:${path}${options.clean ? ' and DELETE remote files that are not in this directory' : ''}?`,
        options,
    );
    if (options.backup) {
        info(err.dim('No automatic backup on a VPS: take a snapshot in the panel first if needed.'));
    }

    step(`rsync to ${target.user}@${target.host}:${path}`);
    await deployToVps(root, service, selection, vpsOptions);
    success(`Synchronized ${selection.files.length} files to ${service.name}:${path}.`);

    if (options.run) {
        step(`Running: ${options.run}`);
        const result = await ssh(target, `cd ${path} && ${options.run}`, vpsOptions, false);
        if (result.code !== 0) {
            throw new CliError(`The command exited with code ${result.code}.`, ExitCode.ERROR);
        }
    }
}

async function deploy(dir: string, options: DeployOptions): Promise<void> {
    const root = resolve(dir);
    const client = await requireClient();
    const service = await resolveService(client, options.service);
    const selection = await collectFiles(root);
    summarize(root, selection);

    if (serviceKind(service) === 'vps') {
        await deployVps(service, root, selection, options);
        return;
    }
    if (options.run) {
        throw new CliError('--run is for VPS deployments.', ExitCode.USAGE, 'On a game server or bot, set the startup command in the panel.');
    }
    await deployGame(client, service, root, selection, options);
}

export function registerDeployCommand(program: Command): void {
    program
        .command('deploy')
        .argument('[dir]', 'local directory to deploy', '.')
        .description('Deploy a local directory to a game server, bot (archive) or VPS (rsync over SSH)')
        .requiredOption('-s, --service <service>', 'target service (identifier, uuid or name)')
        .option('--path <path>', 'target directory on the service (default / ; required for a VPS)')
        .option('--clean', 'remove the files already in the target directory first (approval may be required)')
        .option('--keep <names>', 'comma-separated names kept by --clean (e.g. world,.env)')
        .option('--no-backup', 'do not create a backup first')
        .option('--no-restart', 'do not restart the service after deploying')
        .option('--follow <seconds>', 'seconds of console output to show after the restart', '20')
        .option('--run <command>', 'VPS: command to run in the target directory after the sync')
        .option('--ssh-key <path>', 'VPS: private key for SSH')
        .option('-y, --yes', 'do not ask for confirmation (deploy even when no backup can be made)')
        .option('--dry-run', 'list what would be deployed, send nothing')
        .action((dir: string, options: DeployOptions) => deploy(dir, options));
}
