import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { waitForApproval } from '../src/approvals.js';
import { ApiError, CliError, ExitCode, describeError } from '../src/errors.js';
import { json, mockFetch, noContent, noSleep } from './helpers.js';

const approval = {
    id: 'appr-1',
    status: 'pending',
    action: 'files.delete',
    summary: 'Delete 2 files in /plugins',
    details: ['/plugins/a.jar', '/plugins/b.jar'],
    approve_url: 'https://panel.test/dashboard/account/agents?approval=appr-1',
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
};

const approvalRequired = () =>
    json(
        {
            errors: [{ code: 'approval_required', status: '428', detail: 'This action needs the approval of the account holder.' }],
            approval,
        },
        428,
    );

const statusResponse = (status: string) => () => json({ data: { ...approval, status } });

describe('approval flow', () => {
    it('waits for the approval, then repeats exactly the same request with X-Agent-Approval', async () => {
        const { fetch, calls } = mockFetch({
            'POST /api/client/servers/abcd1234/files/delete': [approvalRequired, () => noContent()],
            'GET /api/client/agent/approvals/appr-1': [statusResponse('pending'), statusResponse('pending'), statusResponse('approved')],
        });
        const seen: string[] = [];
        const client = new ApiClient({
            panelUrl: 'https://panel.test',
            token: 't',
            fetch,
            approvalHandler: (info, self) => waitForApproval(self, info, { sleep: noSleep, onStatus: (s) => seen.push(s) }),
        });

        await client.post('/api/client/servers/abcd1234/files/delete', { root: '/plugins', files: ['a.jar', 'b.jar'] });

        const deletes = calls.filter((call) => call.url.pathname.endsWith('/files/delete'));
        assert.equal(deletes.length, 2);
        assert.equal(deletes[0]?.body, deletes[1]?.body);
        assert.equal(deletes[0]?.headers.get('x-agent-approval'), null);
        assert.equal(deletes[1]?.headers.get('x-agent-approval'), 'appr-1');
        assert.deepEqual(seen, ['pending', 'pending', 'approved']);
    });

    it('stops with an approval exit code when the holder denies it', async () => {
        const { fetch } = mockFetch({
            'POST /api/client/servers/abcd1234/files/delete': approvalRequired,
            'GET /api/client/agent/approvals/appr-1': [statusResponse('pending'), statusResponse('denied')],
        });
        const client = new ApiClient({
            panelUrl: 'https://panel.test',
            token: 't',
            fetch,
            approvalHandler: (info, self) => waitForApproval(self, info, { sleep: noSleep }),
        });

        await assert.rejects(
            client.post('/api/client/servers/abcd1234/files/delete', { root: '/', files: ['x'] }),
            (error: unknown) => error instanceof CliError && error.exitCode === ExitCode.APPROVAL,
        );
    });

    it('reports an expired request', async () => {
        const { fetch } = mockFetch({ 'GET /api/client/agent/approvals/appr-1': statusResponse('expired') });
        const client = new ApiClient({ panelUrl: 'https://panel.test', token: 't', fetch });
        await assert.rejects(waitForApproval(client, approval, { sleep: noSleep }), /expired/);
    });

    it('surfaces the approval as an ApiError without a handler (MCP)', async () => {
        const { fetch } = mockFetch({ 'POST /api/client/servers/abcd1234/files/deploy': approvalRequired });
        const client = new ApiClient({ panelUrl: 'https://panel.test', token: 't', fetch });

        await assert.rejects(client.post('/api/client/servers/abcd1234/files/deploy', {}), (error: unknown) => {
            assert.ok(error instanceof ApiError);
            assert.equal(error.isApprovalRequired, true);
            assert.equal(error.approval?.approve_url, approval.approve_url);
            assert.equal(describeError(error).exitCode, ExitCode.APPROVAL);
            return true;
        });
    });

    it('explains a missing permission', async () => {
        const { fetch } = mockFetch({
            'POST /api/client/servers/abcd1234/power': () =>
                json({ errors: [{ code: 'insufficient_scope', status: '403', detail: 'No' }], required_scope: 'services.power' }, 403),
        });
        const client = new ApiClient({ panelUrl: 'https://panel.test', token: 't', fetch });

        await assert.rejects(client.post('/api/client/servers/abcd1234/power', { signal: 'start' }), (error: unknown) => {
            const described = describeError(error);
            assert.equal(described.exitCode, ExitCode.FORBIDDEN);
            assert.match(described.message, /services\.power/);
            return true;
        });
    });
});
