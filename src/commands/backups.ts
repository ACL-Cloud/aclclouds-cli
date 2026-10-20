import type { Command } from 'commander';
import type { ApiClient } from '../api/client.js';
import type { Service } from '../api/types.js';
import { createBackup, listBackups, matchBackup, requireWingsService, waitForBackup } from '../backups.js';
import { requireClient } from '../context.js';
import { CliError, ExitCode } from '../errors.js';
import { Spinner, confirm, formatBytes, isInteractive, out, print, printJson, success, table } from '../output.js';
import { resolveService, servicePath } from '../services.js';

async function backupService(query: string): Promise<{ client: ApiClient; service: Service }> {
    const client = await requireClient();
    const service = await resolveService(client, query);
    requireWingsService(service, 'Backups from the CLI');
    return { client, service };
}

function backupState(completedAt: string | null, successful: boolean): string {
    if (!completedAt) {
        return out.yellow('in progress');
    }
    return successful ? out.green('ok') : out.red('failed');
}

async function ls(query: string, options: { json?: boolean }): Promise<void> {
    const { client, service } = await backupService(query);
    const { backups, count } = await listBackups(client, service);

    if (options.json) {
        printJson({ backups, count, limit: service.feature_limits?.backups ?? null });
        return;
    }
    if (backups.length === 0) {
        print('No backups.');
    } else {
        print(
            table(
                ['ID', 'NAME', 'SIZE', 'CREATED', 'STATE'],
                backups.map((backup) => [
                    backup.uuid,
                    backup.name + (backup.is_locked ? out.dim(' (locked)') : ''),
                    formatBytes(backup.bytes),
                    new Date(backup.created_at).toLocaleString(),
                    backupState(backup.completed_at, backup.is_successful),
                ]),
            ),
        );
    }
    if (service.feature_limits?.backups !== undefined) {
        print(out.dim(`${count} / ${service.feature_limits.backups} backups used`));
    }
}

async function create(query: string, options: { name?: string; wait?: boolean }): Promise<void> {
    const { client, service } = await backupService(query);
    const backup = await createBackup(client, service, options.name);
    if (!options.wait) {
        success(`Backup ${backup.uuid} started on ${service.name}.`);
        return;
    }

    const spinner = new Spinner().start('Backing up…');
    try {
        const done = await waitForBackup(client, service, backup.uuid);
        spinner.stop();
        if (!done.is_successful) {
            throw new CliError(`The backup ${done.uuid} failed.`, ExitCode.ERROR);
        }
        success(`Backup ${done.uuid} completed (${formatBytes(done.bytes)}).`);
    } finally {
        spinner.stop();
    }
}

async function restore(query: string, id: string, options: { truncate?: boolean; yes?: boolean }): Promise<void> {
    const { client, service } = await backupService(query);
    const backup = matchBackup((await listBackups(client, service)).backups, id);

    if (!options.yes && isInteractive()) {
        const what = options.truncate ? 'All current files will be deleted first. ' : '';
        if (!(await confirm(`Restore "${backup.name}" on ${service.name}? ${what}The service is stopped during the restore.`))) {
            throw new CliError('Cancelled.', ExitCode.ERROR);
        }
    }

    await client.post(servicePath(service, `/backups/${backup.uuid}/restore`), { truncate: Boolean(options.truncate) });
    success(`Restoring "${backup.name}" on ${service.name}. Follow it with \`aclclouds status ${service.identifier}\`.`);
}

export function registerBackupCommands(program: Command): void {
    const backups = program.command('backups').description('List, create and restore backups of a game server or bot');

    backups
        .command('ls')
        .argument('<service>', 'identifier, uuid or name')
        .description('List backups')
        .option('--json', 'JSON output')
        .action((query: string, options: { json?: boolean }) => ls(query, options));

    backups
        .command('create')
        .argument('<service>')
        .description('Create a backup')
        .option('--name <name>', 'backup name')
        .option('-w, --wait', 'wait until the backup is completed')
        .action((query: string, options: { name?: string; wait?: boolean }) => create(query, options));

    backups
        .command('restore')
        .argument('<service>')
        .argument('<backup>', 'backup id (or its beginning) or name')
        .description('Restore a backup (the account holder may have to approve it in the panel)')
        .option('--truncate', 'delete all current files before restoring')
        .option('-y, --yes', 'do not ask for confirmation')
        .action((query: string, id: string, options: { truncate?: boolean; yes?: boolean }) => restore(query, id, options));
}
