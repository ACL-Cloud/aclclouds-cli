import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, ExitCode } from './errors.js';

export const DEFAULT_PANEL_URL = 'https://aclclouds.com';

/** OAuth client of the official CLI (device flow). */
export const CLIENT_ID = 'aclclouds-cli';

export interface StoredAccount {
    username?: string;
    email?: string;
}

/** Content of `config.json`. The token never leaves this file except in the Authorization header. */
export interface StoredConfig {
    panel_url?: string;
    token?: string;
    account?: StoredAccount | null;
    /** `device` = created by `aclclouds login` (revocable with `logout`), `api_key` = pasted key. */
    token_source?: 'device' | 'api_key';
    scopes?: string[];
}

type Env = Record<string, string | undefined>;

/** `~/.config/aclclouds` (XDG_CONFIG_HOME respected), `%APPDATA%\aclclouds` on Windows. */
export function configDir(env: Env = process.env, platform: string = process.platform, home: string = homedir()): string {
    if (platform === 'win32') {
        return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'aclclouds');
    }
    return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'aclclouds');
}

export function configPath(env: Env = process.env): string {
    return env.ACLCLOUDS_CONFIG || join(configDir(env), 'config.json');
}

export async function readConfig(path: string = configPath()): Promise<StoredConfig> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw error;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as StoredConfig) : {};
    } catch {
        throw new CliError(`The configuration file ${path} is not valid JSON.`, ExitCode.ERROR, 'Delete it and run `aclclouds login` again.');
    }
}

/** Writes the configuration atomically, readable by the current user only (0600). */
export async function writeConfig(config: StoredConfig, path: string = configPath()): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
}

export async function deleteConfig(path: string = configPath()): Promise<void> {
    await rm(path, { force: true });
}

/**
 * Validates a panel URL. HTTPS is required, except for local development hosts,
 * so the token is never sent in clear text.
 */
export function normalizePanelUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new CliError(`Invalid panel URL: ${raw}`, ExitCode.USAGE, 'Example: --url https://aclclouds.com');
    }

    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.test');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        throw new CliError(`The panel URL must use https:// (got ${url.protocol}//${url.host}).`, ExitCode.USAGE);
    }

    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export interface Session {
    panelUrl: string;
    token: string | null;
    tokenFrom: 'env' | 'config' | null;
    config: StoredConfig;
    path: string;
}

/** Resolves the panel and token: environment first (ACLCLOUDS_TOKEN, ACLCLOUDS_URL), then config.json. */
export async function loadSession(env: Env = process.env): Promise<Session> {
    const path = configPath(env);
    const config = await readConfig(path);
    const panelUrl = normalizePanelUrl(env.ACLCLOUDS_URL || config.panel_url || DEFAULT_PANEL_URL);
    const envToken = env.ACLCLOUDS_TOKEN?.trim();

    if (envToken) {
        return { panelUrl, token: envToken, tokenFrom: 'env', config, path };
    }
    // A stored token is only sent to the panel it was created for.
    const storedPanel = normalizePanelUrl(config.panel_url || DEFAULT_PANEL_URL);
    if (config.token && storedPanel === panelUrl) {
        return { panelUrl, token: config.token, tokenFrom: 'config', config, path };
    }
    return { panelUrl, token: null, tokenFrom: null, config, path };
}
