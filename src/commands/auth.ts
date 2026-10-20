import { hostname } from 'node:os';
import type { Command } from 'commander';
import { ApiClient } from '../api/client.js';
import { unwrapItem } from '../api/fractal.js';
import type { Account } from '../api/types.js';
import { PRESETS, isPreset, pollDeviceToken, requestDeviceCode, revokeToken } from '../auth/device.js';
import { openBrowser } from '../browser.js';
import { DEFAULT_PANEL_URL, type StoredConfig, loadSession, normalizePanelUrl, readConfig, writeConfig, configPath } from '../config.js';
import { requireClient } from '../context.js';
import { ApiError, CliError, ExitCode } from '../errors.js';
import { Spinner, askSecret, err, info, isInteractive, print, printJson, readStdin, success, warn } from '../output.js';

interface LoginOptions {
    url?: string;
    token?: string | boolean;
    preset: string;
    browser: boolean;
}

async function fetchAccount(panelUrl: string, token: string): Promise<Account> {
    try {
        return unwrapItem<Account>(await new ApiClient({ panelUrl, token }).get('/api/client/account'));
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            throw new CliError('This key was rejected by the panel.', ExitCode.AUTH, 'Check that you copied the whole key.');
        }
        throw error;
    }
}

async function readPastedKey(option: string | boolean): Promise<string> {
    if (typeof option === 'string' && option !== '-') {
        return option.trim();
    }
    if (process.stdin.isTTY) {
        return askSecret('Paste your ACLClouds API key: ');
    }
    return (await readStdin()).trim();
}

async function login(options: LoginOptions): Promise<void> {
    const path = configPath();
    const previous = await readConfig(path);
    const panelUrl = normalizePanelUrl(options.url || process.env.ACLCLOUDS_URL || previous.panel_url || DEFAULT_PANEL_URL);

    let config: StoredConfig;
    if (options.token !== undefined && options.token !== false) {
        const token = await readPastedKey(options.token);
        if (!token) {
            throw new CliError('No API key given.', ExitCode.USAGE);
        }
        const account = await fetchAccount(panelUrl, token);
        config = { panel_url: panelUrl, token, token_source: 'api_key', account: { username: account.username, email: account.email } };
    } else {
        if (!isPreset(options.preset)) {
            throw new CliError(`Unknown preset "${options.preset}".`, ExitCode.USAGE, `Use one of: ${Object.keys(PRESETS).join(', ')}.`);
        }
        const code = await requestDeviceCode(panelUrl, {
            scope: PRESETS[options.preset].join(' '),
            deviceName: hostname(),
        });
        const link = code.verification_uri_complete || code.verification_uri;

        info('');
        info(`To sign in, open ${err.underline(link)}`);
        info(`and check that the code shown is ${err.bold(err.cyan(code.user_code))}.`);
        info(err.dim(`Requested permissions (${options.preset}): ${PRESETS[options.preset].join(', ')}`));
        if (options.browser && isInteractive() && openBrowser(link)) {
            info(err.dim('(opened in your browser)'));
        }
        info('');

        const spinner = new Spinner().start('Waiting for you to approve in the browser… (Ctrl+C to cancel)');
        let token;
        try {
            token = await pollDeviceToken(panelUrl, code);
        } finally {
            spinner.stop();
        }

        const account = await fetchAccount(panelUrl, token.access_token);
        config = {
            panel_url: panelUrl,
            token: token.access_token,
            token_source: 'device',
            scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : [...PRESETS[options.preset]],
            account: { username: account.username, email: account.email },
        };
    }

    await writeConfig(config, path);

    // The token of the previous `aclclouds login` is not needed anymore.
    if (previous.token && previous.token !== config.token && previous.token_source === 'device') {
        await revokeToken(normalizePanelUrl(previous.panel_url || DEFAULT_PANEL_URL), previous.token);
    }

    success(`Signed in as ${err.bold(config.account?.username || config.account?.email || 'your account')} on ${panelUrl}.`);
    if (process.env.ACLCLOUDS_TOKEN) {
        warn('ACLCLOUDS_TOKEN is set in your environment and takes precedence over this login.');
    }
    info(err.dim('Next: `aclclouds services` to list your services.'));
}

async function logout(): Promise<void> {
    const session = await loadSession();
    const config = session.config;

    if (!config.token) {
        info('No stored session.');
    } else {
        if (config.token_source === 'device') {
            const revoked = await revokeToken(normalizePanelUrl(config.panel_url || DEFAULT_PANEL_URL), config.token);
            if (!revoked) {
                warn('Could not revoke the token on the panel: delete it in Account > AI & automation.');
            }
        } else {
            info(err.dim('This was a key created in the panel: delete it there (Account > API keys) if you no longer need it.'));
        }
        await writeConfig(config.panel_url ? { panel_url: config.panel_url } : {}, session.path);
        success('Signed out: the token was removed from this computer.');
    }

    if (process.env.ACLCLOUDS_TOKEN) {
        warn('ACLCLOUDS_TOKEN is still set in your environment.');
    }
}

async function whoami(options: { json?: boolean }): Promise<void> {
    const session = await loadSession();
    const client = await requireClient();
    const account = unwrapItem<Account>(await client.get('/api/client/account'));
    const details = {
        panel_url: session.panelUrl,
        username: account.username ?? null,
        email: account.email ?? null,
        token_from: session.tokenFrom,
        token_source: session.tokenFrom === 'config' ? (session.config.token_source ?? null) : null,
        scopes: session.tokenFrom === 'config' ? (session.config.scopes ?? null) : null,
    };

    if (options.json) {
        printJson(details);
        return;
    }
    print(`${account.username ?? '-'} <${account.email ?? '-'}>`);
    print(`Panel:  ${session.panelUrl}`);
    print(`Token:  ${session.tokenFrom === 'env' ? 'ACLCLOUDS_TOKEN (environment)' : session.path}`);
    if (details.scopes) {
        print(`Scopes: ${details.scopes.join(', ')}`);
    }
}

export function registerAuthCommands(program: Command): void {
    program
        .command('login')
        .description('Sign in (opens the panel to approve this computer), or store an API key with --token')
        .option('--url <url>', 'panel URL (default https://aclclouds.com, or ACLCLOUDS_URL)')
        .option('--token [key]', 'store an API key created in the panel instead (prompted, or read from stdin, when no value)')
        .option('--preset <preset>', 'permissions to request: read, operate, deploy or full', 'deploy')
        .option('--no-browser', 'do not open the browser')
        .action((options: LoginOptions) => login(options));

    program
        .command('logout')
        .description('Revoke the CLI token and remove it from this computer')
        .action(() => logout());

    program
        .command('whoami')
        .description('Show the signed-in account')
        .option('--json', 'JSON output')
        .action((options: { json?: boolean }) => whoami(options));
}
