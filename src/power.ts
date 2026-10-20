import type { ApiClient } from './api/client.js';
import { unwrapItem } from './api/fractal.js';
import type { Resources, Service, VpsStatus } from './api/types.js';
import { type Sleep, sleep as defaultSleep } from './approvals.js';
import { CliError, ExitCode } from './errors.js';
import { serviceKind, servicePath } from './services.js';

export const POWER_ACTIONS = ['start', 'stop', 'restart', 'kill'] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

const VPS_ROUTES: Record<PowerAction, string> = {
    start: 'start',
    stop: 'stop',
    restart: 'restart',
    kill: 'force-stop',
};

export async function sendPower(client: ApiClient, service: Service, action: PowerAction): Promise<void> {
    if (serviceKind(service) === 'vps') {
        await client.post(servicePath(service, `/vps/${VPS_ROUTES[action]}`));
        return;
    }
    await client.post(servicePath(service, '/power'), { signal: action });
}

/** Live state: `running`, `offline`, `starting`, `stopping`, or what the panel reports. */
export async function getState(client: ApiClient, service: Service): Promise<string> {
    if (serviceKind(service) === 'vps') {
        const status = await client.get<VpsStatus>(servicePath(service, '/vps/status'));
        return normalizeVpsState(status?.status);
    }
    const resources = unwrapItem<Resources>(await client.get(servicePath(service, '/resources')));
    return resources?.current_state || 'unknown';
}

export function normalizeVpsState(status: string | undefined): string {
    if (status === 'stopped') {
        return 'offline';
    }
    return status || 'unknown';
}

export function targetState(action: PowerAction): 'running' | 'offline' {
    return action === 'start' || action === 'restart' ? 'running' : 'offline';
}

export interface WaitOptions {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: Sleep;
    now?: () => number;
    onState?: (state: string) => void;
}

/**
 * Polls the state until the action's target is reached. For a restart, a
 * `running` state only counts once the service was seen going down, or after
 * the panel's 20 s resource cache has expired.
 */
export async function waitForPowerState(
    client: ApiClient,
    service: Service,
    action: PowerAction,
    options: WaitOptions = {},
): Promise<string> {
    const wait = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const started = now();
    const deadline = started + (options.timeoutMs ?? 120_000);
    const target = targetState(action);
    let sawTransition = action !== 'restart';
    let state = 'unknown';

    while (now() < deadline) {
        await wait(options.intervalMs ?? 3000);
        state = await getState(client, service);
        options.onState?.(state);
        if (state !== 'running') {
            sawTransition = true;
        }
        if (state === target && (sawTransition || now() - started > 25_000)) {
            return state;
        }
    }

    throw new CliError(
        `Timed out waiting for ${service.name} to be ${target} (last state: ${state}).`,
        ExitCode.TIMEOUT,
        'Check the logs with `aclclouds logs`.',
    );
}
