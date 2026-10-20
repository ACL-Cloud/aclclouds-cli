import type { Command } from 'commander';
import { sleep } from '../approvals.js';
import { requireClient } from '../context.js';
import { CliError, ExitCode } from '../errors.js';
import { LogFollower, MAX_LOG_LINES, fetchLogs } from '../logs.js';
import { print, printJson } from '../output.js';
import { resolveService, serviceKind } from '../services.js';

interface LogsOptions {
    lines: string;
    follow?: boolean;
    json?: boolean;
    interval: string;
}

async function logs(query: string, options: LogsOptions): Promise<void> {
    const lines = Number(options.lines);
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
        throw new CliError(`-n must be between 1 and ${MAX_LOG_LINES}.`, ExitCode.USAGE);
    }

    const client = await requireClient();
    const service = await resolveService(client, query);
    if (serviceKind(service) === 'vps') {
        throw new CliError(
            'Console logs are available for game servers and bots only.',
            ExitCode.USAGE,
            `On a VPS, read logs with a command, e.g. \`aclclouds exec ${service.identifier} -- journalctl -n 100 --no-pager\`.`,
        );
    }

    if (!options.follow) {
        const result = await fetchLogs(client, service, lines);
        if (options.json) {
            printJson(result);
        } else {
            for (const line of result) {
                print(line);
            }
        }
        return;
    }

    const intervalMs = Math.max(1, Number(options.interval) || 2) * 1000;
    const follower = new LogFollower(client, service);
    for (const line of await follower.prime(lines)) {
        print(line);
    }

    let stop = false;
    process.once('SIGINT', () => {
        stop = true;
    });
    while (!stop) {
        await sleep(intervalMs);
        if (stop) {
            break;
        }
        for (const line of await follower.poll()) {
            print(line);
        }
    }
}

export function registerLogCommands(program: Command): void {
    program
        .command('logs')
        .argument('<service>', 'identifier, uuid or name')
        .description('Show the console output of a game server or bot')
        .option('-n, --lines <count>', `number of lines (max ${MAX_LOG_LINES})`, '100')
        .option('-f, --follow', 'keep printing new lines (Ctrl+C to stop)')
        .option('--interval <seconds>', 'polling interval with --follow', '2')
        .option('--json', 'JSON output (array of lines)')
        .action((query: string, options: LogsOptions) => logs(query, options));
}
