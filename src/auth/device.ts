import { type FetchLike, readBody } from '../api/client.js';
import { type Sleep, sleep as defaultSleep } from '../approvals.js';
import { CLIENT_ID } from '../config.js';
import { CliError, ExitCode } from '../errors.js';
import { USER_AGENT } from '../version.js';

/** Permission presets, same as the panel (`AgentScope::PRESETS`). */
export const PRESETS = {
    read: ['services.read', 'services.console', 'files.read', 'billing.read'],
    operate: ['services.read', 'services.power', 'services.console', 'files.read', 'backups'],
    deploy: ['services.read', 'services.power', 'services.console', 'files.read', 'files.write', 'backups'],
    full: [
        'services.read',
        'services.power',
        'services.console',
        'files.read',
        'files.write',
        'backups',
        'settings',
        'vps.shell',
        'billing.read',
        'domains',
    ],
} as const;

export type Preset = keyof typeof PRESETS;

export function isPreset(value: string): value is Preset {
    return Object.prototype.hasOwnProperty.call(PRESETS, value);
}

/** RFC 8628 device authorization response. */
export interface DeviceCode {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
}

export interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function postForm(fetchImpl: FetchLike, url: string, fields: Record<string, string>) {
    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT,
            },
            body: new URLSearchParams(fields).toString(),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        throw new CliError(
            `Could not reach ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`,
            ExitCode.ERROR,
            'Check your connection, or the panel URL (--url / ACLCLOUDS_URL).',
        );
    }
    return { response, data: (await readBody(response)) as Record<string, unknown> | undefined };
}

export async function requestDeviceCode(
    panelUrl: string,
    options: { scope?: string; deviceName: string },
    fetchImpl: FetchLike = fetch,
): Promise<DeviceCode> {
    const fields: Record<string, string> = { client_id: CLIENT_ID, device_name: options.deviceName };
    if (options.scope) {
        fields.scope = options.scope;
    }

    const { response, data } = await postForm(fetchImpl, `${panelUrl}/oauth/device/code`, fields);
    if (!response.ok || !data || typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
        const reason = typeof data?.error_description === 'string' ? data.error_description : `HTTP ${response.status}`;
        throw new CliError(
            `The panel refused to start the sign-in (${reason}).`,
            ExitCode.AUTH,
            'Try again later, or create a key in the panel and run `aclclouds login --token`.',
        );
    }
    return data as unknown as DeviceCode;
}

export interface PollOptions {
    fetch?: FetchLike;
    sleep?: Sleep;
    now?: () => number;
    onPending?: () => void;
}

/**
 * Polls the token endpoint (RFC 8628 §3.4): waits `interval` seconds between
 * attempts, adds 5 s on `slow_down`, stops on denial or expiry.
 */
export async function pollDeviceToken(panelUrl: string, code: DeviceCode, options: PollOptions = {}): Promise<TokenResponse> {
    const fetchImpl = options.fetch ?? fetch;
    const wait = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    let intervalMs = Math.max(1, code.interval ?? 5) * 1000;
    const deadline = now() + Math.max(1, code.expires_in) * 1000;

    while (now() < deadline) {
        await wait(intervalMs);
        const { response, data } = await postForm(fetchImpl, `${panelUrl}/oauth/token`, {
            grant_type: DEVICE_GRANT,
            device_code: code.device_code,
            client_id: CLIENT_ID,
        });

        if (response.ok && data && typeof data.access_token === 'string') {
            return data as unknown as TokenResponse;
        }

        const error = typeof data?.error === 'string' ? data.error : `http_${response.status}`;
        if (response.status >= 500) {
            // Transient panel error: keep polling until the code expires.
            continue;
        }
        switch (error) {
            case 'authorization_pending':
                options.onPending?.();
                continue;
            case 'slow_down':
                intervalMs += 5000;
                continue;
            case 'access_denied':
                throw new CliError('Sign-in was denied in the panel.', ExitCode.AUTH);
            case 'expired_token':
                throw new CliError('The sign-in code expired.', ExitCode.AUTH, 'Run `aclclouds login` again.');
            default:
                throw new CliError(
                    `Sign-in failed (${typeof data?.error_description === 'string' ? data.error_description : error}).`,
                    ExitCode.AUTH,
                );
        }
    }

    throw new CliError('The sign-in code expired.', ExitCode.AUTH, 'Run `aclclouds login` again.');
}

/** RFC 7009 revocation. Resolves to false when the panel could not be reached or refused. */
export async function revokeToken(panelUrl: string, token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
    try {
        const { response } = await postForm(fetchImpl, `${panelUrl}/oauth/revoke`, { token, client_id: CLIENT_ID });
        return response.ok;
    } catch {
        return false;
    }
}
