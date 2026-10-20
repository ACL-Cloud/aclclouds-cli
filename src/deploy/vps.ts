import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Service } from '../api/types.js';
import type { FileSelection } from '../archive.js';
import { CliError, ExitCode } from '../errors.js';

export interface VpsTarget {
    host: string;
    user: string;
}

export interface VpsDeployOptions {
    /** Absolute or `~/` path on the VPS. */
    path: string;
    clean: boolean;
    keep: string[];
    sshKey?: string;
    /** Never prompt (MCP, CI): fail instead of asking for a password or host key. */
    batch?: boolean;
}

/** Directories a clean deployment must never empty. */
const PROTECTED = new Set(['/', '/root', '/home', '/etc', '/usr', '/var', '/bin', '/boot', '/lib', '/opt', '/srv', '~', '~/']);

export function vpsTarget(service: Service): VpsTarget {
    const host = service.vps?.ipv4?.split('/')[0];
    if (!host) {
        throw new CliError(`${service.name} has no public IPv4 yet.`, ExitCode.ERROR, 'Wait for the VPS to be ready, then try again.');
    }
    return { host, user: service.vps?.username || 'root' };
}

/** Validates the remote path: simple characters only (no quoting needed on the remote shell). */
export function checkVpsPath(path: string | undefined, clean: boolean): string {
    if (!path) {
        throw new CliError('Choose where to deploy on the VPS with --path.', ExitCode.USAGE, 'Example: --path /root/my-app');
    }
    const value = path.replace(/\/+$/, '') || '/';
    if (!/^(~\/|\/)[A-Za-z0-9._\/-]*$/.test(value) && value !== '~') {
        throw new CliError(
            `Unsupported path on the VPS: ${path}`,
            ExitCode.USAGE,
            'Use an absolute path (or ~/...) made of letters, digits, ".", "_", "-" and "/".',
        );
    }
    if (value.split('/').includes('..')) {
        throw new CliError(`Unsupported path on the VPS: ${path}`, ExitCode.USAGE);
    }
    if (clean && PROTECTED.has(value)) {
        throw new CliError(`Refusing a clean deployment into ${value}.`, ExitCode.USAGE, 'Deploy into a dedicated directory.');
    }
    return value;
}

export function hasBinary(name: string): boolean {
    const result = spawnSync(name, [name === 'ssh' ? '-V' : '--version'], { stdio: 'ignore' });
    return !result.error;
}

export function requireBinaries(): void {
    const missing = ['ssh', 'rsync'].filter((name) => !hasBinary(name));
    if (missing.length > 0) {
        throw new CliError(
            `Deploying to a VPS needs ${missing.join(' and ')}, not found on this machine.`,
            ExitCode.ERROR,
            process.platform === 'win32'
                ? 'Run the CLI from WSL, or install rsync and OpenSSH (e.g. with Git for Windows / MSYS2).'
                : 'Install them (e.g. `apt install rsync openssh-client` or `brew install rsync`).',
        );
    }
}

function escapeRsyncPattern(path: string): string {
    return path.replace(/[*?[\\]/g, '\\$&');
}

/**
 * Exclude rules for rsync: exactly what the archive walk ignored (anchored),
 * plus symlinks, plus the names kept by a clean deployment. Excluded paths are
 * also protected from `--delete` on the VPS.
 */
export function rsyncExcludes(selection: FileSelection, options: Pick<VpsDeployOptions, 'clean' | 'keep'>): string[] {
    const rules = [...selection.ignored, ...selection.symlinks].map((path) => `/${escapeRsyncPattern(path)}`);
    if (options.clean) {
        rules.push(...options.keep.map((name) => `/${escapeRsyncPattern(name.replace(/^\/+/, ''))}`));
    }
    return rules;
}

export function sshOptions(options: Pick<VpsDeployOptions, 'sshKey' | 'batch'>): string[] {
    const args = ['-o', 'StrictHostKeyChecking=accept-new'];
    if (options.batch) {
        args.push('-o', 'BatchMode=yes');
    }
    if (options.sshKey) {
        args.push('-i', options.sshKey);
    }
    return args;
}

export function rsyncArgs(root: string, target: VpsTarget, excludeFile: string, options: VpsDeployOptions): string[] {
    const ssh = ['ssh', ...sshOptions(options)].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
    const args = ['-az', '--exclude-from', excludeFile, '-e', ssh];
    if (options.clean) {
        args.push('--delete');
    }
    args.push(`${root.replace(/[\\/]+$/, '')}/`, `${target.user}@${target.host}:${options.path}/`);
    return args;
}

export interface RunResult {
    code: number;
    output: string;
}

/** Runs a command; output is inherited (CLI) or captured (MCP). */
export function run(command: string, args: string[], capture: boolean): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
        let output = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 1, output: output.slice(-20_000) }));
    });
}

export function ssh(target: VpsTarget, command: string, options: VpsDeployOptions, capture: boolean): Promise<RunResult> {
    return run('ssh', [...sshOptions(options), `${target.user}@${target.host}`, command], capture);
}

/** Creates the directory, then synchronizes the selected files with rsync over SSH. */
export async function deployToVps(
    root: string,
    service: Service,
    selection: FileSelection,
    options: VpsDeployOptions,
    capture = false,
): Promise<RunResult> {
    requireBinaries();
    const target = vpsTarget(service);
    const path = checkVpsPath(options.path, options.clean);

    const mkdir = await ssh(target, `mkdir -p ${path}`, options, capture);
    if (mkdir.code !== 0) {
        throw new CliError(
            `Could not connect to ${target.user}@${target.host} over SSH (exit ${mkdir.code}).${capture ? `\n${mkdir.output}` : ''}`,
            ExitCode.ERROR,
            'Add your SSH key to the VPS (panel > VPS > SSH keys) or pass --ssh-key.',
        );
    }

    const workdir = await mkdtemp(join(tmpdir(), 'aclclouds-'));
    try {
        const excludeFile = join(workdir, 'exclude.txt');
        await writeFile(excludeFile, `${rsyncExcludes(selection, options).join('\n')}\n`);
        const result = await run('rsync', rsyncArgs(root, target, excludeFile, { ...options, path }), capture);
        if (result.code !== 0) {
            throw new CliError(`rsync failed (exit ${result.code}).${capture ? `\n${result.output}` : ''}`, ExitCode.ERROR);
        }
        return result;
    } finally {
        await rm(workdir, { recursive: true, force: true });
    }
}
