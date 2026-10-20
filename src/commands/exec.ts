import type { Command } from 'commander';
import type { VpsShellResponse } from '../api/types.js';
import { sleep } from '../approvals.js';
import { requireClient } from '../context.js';
import { CliError, ExitCode } from '../errors.js';
import { LogFollower } from '../logs.js';
import { err, info, print, printJson, warn } from '../output.js';
import { resolveService, serviceKind, servicePath } from '../services.js';

interface ExecOptions {
    cwd?: string;
    wait: string;
    json?: boolean;
}

async function exec(query: string, words: string[], options: ExecOptions): Promise<void> {
    const command = words.join(' ').trim();
    if (!command) {
        throw new CliError('No command given.', ExitCode.USAGE, 'Example: aclclouds exec my-server -- say hello');
    }

    const client = await requireClient();
    const service = await resolveService(client, query);

    if (serviceKind(service) === 'vps') {
        const response = await client.post<VpsShellResponse>(servicePath(service, '/vps/shell'), {
            command,
            ...(options.cwd ? { cwd: options.cwd } : {}),
        });
        if (response.error) {
            throw new CliError(response.error, ExitCode.ERROR, response.agent_required ? 'The QEMU guest agent must run in the VPS.' : undefined);
        }
        const result = response.result ?? {};
        if (options.json) {
            printJson({ cwd: response.cwd, ...result });
        } else {
            if (result.stdout) {
                process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
            }
            if (result.stderr) {
                process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
            }
        }
        if (result.timed_out) {
            warn('The command was still running after 15 s: its output may be incomplete.');
            process.exitCode = ExitCode.TIMEOUT;
        } else if (typeof result.exit_code === 'number' && result.exit_code !== 0) {
            process.exitCode = Math.min(255, result.exit_code);
        }
        return;
    }

    const follower = new LogFollower(client, service);
    await follower.prime().catch(() => []);
    await client.post(servicePath(service, '/command'), { command });

    const waitMs = Math.max(0, Number(options.wait) || 0) * 1000;
    const output: string[] = [];
    for (let elapsed = 0; elapsed < waitMs; elapsed += 1000) {
        await sleep(1000);
        output.push(...(await follower.poll().catch(() => [])));
    }

    if (options.json) {
        printJson({ command, output });
        return;
    }
    if (output.length === 0) {
        info(err.dim('(no console output yet: check later with `aclclouds logs`)'));
    }
    for (const line of output) {
        print(line);
    }
}

export function registerExecCommand(program: Command): void {
    program
        .command('exec')
        .argument('<service>', 'identifier, uuid or name')
        .argument('<command...>', 'command, after `--`')
        .description('Run a console command (game, bot) or a shell command (VPS) and print its output')
        .option('--cwd <dir>', 'working directory (VPS)')
        .option('--wait <seconds>', 'seconds of console output to show (game, bot)', '3')
        .option('--json', 'JSON output')
        .action((query: string, words: string[], options: ExecOptions) => exec(query, words, options));
}
