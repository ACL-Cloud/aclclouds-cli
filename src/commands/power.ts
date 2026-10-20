import type { Command } from 'commander';
import { requireClient } from '../context.js';
import { CliError, ExitCode } from '../errors.js';
import { Spinner, colorState, success } from '../output.js';
import { POWER_ACTIONS, type PowerAction, sendPower, targetState, waitForPowerState } from '../power.js';
import { resolveService } from '../services.js';

const DESCRIPTIONS: Record<PowerAction, string> = {
    start: 'Start a service',
    stop: 'Stop a service',
    restart: 'Restart a service',
    kill: 'Force-stop a service (like pulling the plug)',
};

const DONE: Record<PowerAction, string> = {
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
    kill: 'Kill',
};

interface PowerOptions {
    wait?: boolean;
    timeout: string;
}

async function power(action: PowerAction, query: string, options: PowerOptions): Promise<void> {
    const timeoutSeconds = Number(options.timeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new CliError('--timeout must be a number of seconds.', ExitCode.USAGE);
    }

    const client = await requireClient();
    const service = await resolveService(client, query);
    await sendPower(client, service, action);

    if (!options.wait) {
        success(`${DONE[action]} signal sent to ${service.name}.`);
        return;
    }

    const spinner = new Spinner().start(`Waiting for ${service.name} to be ${targetState(action)}…`);
    try {
        const state = await waitForPowerState(client, service, action, {
            timeoutMs: timeoutSeconds * 1000,
            onState: (current) => spinner.update(`Waiting for ${service.name} to be ${targetState(action)}… (now ${current})`),
        });
        spinner.stop();
        success(`${service.name} is ${colorState(state)}.`);
    } finally {
        spinner.stop();
    }
}

export function registerPowerCommands(program: Command): void {
    for (const action of POWER_ACTIONS) {
        program
            .command(action)
            .argument('<service>', 'identifier, uuid or name')
            .description(DESCRIPTIONS[action])
            .option('-w, --wait', 'wait until the service is running (or offline)')
            .option('--timeout <seconds>', 'maximum wait with --wait', '120')
            .action((query: string, options: PowerOptions) => power(action, query, options));
    }
}
