import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DeviceCode, PRESETS, pollDeviceToken, requestDeviceCode } from '../src/auth/device.js';
import { CliError, ExitCode } from '../src/errors.js';
import { json, mockFetch } from './helpers.js';

const code: DeviceCode = {
    device_code: 'dev-123',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://panel.test/connect',
    verification_uri_complete: 'https://panel.test/connect?code=ABCD-EFGH',
    expires_in: 900,
    interval: 5,
};

const oauthError = (error: string) => () => json({ error, error_description: error }, 400);

describe('device flow', () => {
    it('requests a code with the preset scopes as a form', async () => {
        const { fetch, calls } = mockFetch({ 'POST /oauth/device/code': () => json(code) });
        const result = await requestDeviceCode('https://panel.test', { scope: PRESETS.deploy.join(' '), deviceName: 'laptop' }, fetch);

        assert.equal(result.user_code, 'ABCD-EFGH');
        const form = new URLSearchParams(calls[0]?.body);
        assert.equal(calls[0]?.headers.get('content-type'), 'application/x-www-form-urlencoded');
        assert.equal(form.get('client_id'), 'aclclouds-cli');
        assert.equal(form.get('scope'), 'services.read services.power services.console files.read files.write backups');
        assert.equal(form.get('device_name'), 'laptop');
    });

    it('polls with the interval, slows down on slow_down, and returns the token', async () => {
        const { fetch, calls } = mockFetch({
            'POST /oauth/token': [
                oauthError('authorization_pending'),
                oauthError('slow_down'),
                oauthError('authorization_pending'),
                () => json({ access_token: 'acl_token', token_type: 'Bearer', scope: 'services.read files.read' }),
            ],
        });
        const waits: number[] = [];
        let pending = 0;

        const token = await pollDeviceToken('https://panel.test', code, {
            fetch,
            sleep: async (ms) => {
                waits.push(ms);
            },
            onPending: () => pending++,
        });

        assert.equal(token.access_token, 'acl_token');
        assert.deepEqual(waits, [5000, 5000, 10_000, 10_000]);
        assert.equal(pending, 2);
        const form = new URLSearchParams(calls[0]?.body);
        assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
        assert.equal(form.get('device_code'), 'dev-123');
        assert.equal(form.get('client_id'), 'aclclouds-cli');
    });

    it('stops when the user denies the request', async () => {
        const { fetch } = mockFetch({ 'POST /oauth/token': oauthError('access_denied') });
        await assert.rejects(
            pollDeviceToken('https://panel.test', code, { fetch, sleep: async () => undefined }),
            (error: unknown) => error instanceof CliError && error.exitCode === ExitCode.AUTH && /denied/.test(error.message),
        );
    });

    it('stops when the code expires', async () => {
        const { fetch } = mockFetch({ 'POST /oauth/token': oauthError('expired_token') });
        await assert.rejects(pollDeviceToken('https://panel.test', code, { fetch, sleep: async () => undefined }), /expired/);
    });

    it('gives up at the local deadline', async () => {
        let clock = 0;
        const { fetch } = mockFetch({ 'POST /oauth/token': oauthError('authorization_pending') });
        await assert.rejects(
            pollDeviceToken('https://panel.test', { ...code, expires_in: 12 }, {
                fetch,
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                },
            }),
            /expired/,
        );
    });
});
