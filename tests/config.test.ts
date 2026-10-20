import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configDir, loadSession, normalizePanelUrl, writeConfig } from '../src/config.js';
import { CliError } from '../src/errors.js';

let scratch: string;

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aclclouds-config-'));
});

after(async () => {
    await rm(scratch, { recursive: true, force: true });
});

describe('config', () => {
    it('follows XDG on Unix and APPDATA on Windows', () => {
        assert.equal(configDir({}, 'linux', '/home/a'), join('/home/a', '.config', 'aclclouds'));
        assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/a'), join('/xdg', 'aclclouds'));
        assert.equal(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), join('C:\\Users\\a\\AppData\\Roaming', 'aclclouds'));
    });

    it('writes the token in a file readable by the owner only', { skip: process.platform === 'win32' }, async () => {
        const path = join(scratch, 'nested', 'config.json');
        await writeConfig({ panel_url: 'https://aclclouds.com', token: 'secret' }, path);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'secret');
    });

    it('lets the environment override the stored token and URL', async () => {
        const path = join(scratch, 'env.json');
        await writeConfig({ panel_url: 'https://aclclouds.com', token: 'stored' }, path);

        const stored = await loadSession({ ACLCLOUDS_CONFIG: path });
        assert.equal(stored.token, 'stored');
        assert.equal(stored.tokenFrom, 'config');

        const fromEnv = await loadSession({ ACLCLOUDS_CONFIG: path, ACLCLOUDS_TOKEN: 'env-token' });
        assert.equal(fromEnv.token, 'env-token');
        assert.equal(fromEnv.tokenFrom, 'env');

        // A stored token is never sent to another panel.
        const otherPanel = await loadSession({ ACLCLOUDS_CONFIG: path, ACLCLOUDS_URL: 'https://staging.example.com' });
        assert.equal(otherPanel.panelUrl, 'https://staging.example.com');
        assert.equal(otherPanel.token, null);
    });

    it('requires https except for local development', () => {
        assert.equal(normalizePanelUrl('https://aclclouds.com/'), 'https://aclclouds.com');
        assert.equal(normalizePanelUrl('http://localhost:8000'), 'http://localhost:8000');
        assert.throws(() => normalizePanelUrl('http://aclclouds.com'), CliError);
        assert.throws(() => normalizePanelUrl('not a url'), CliError);
    });
});
