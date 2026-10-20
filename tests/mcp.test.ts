import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike } from '../src/api/client.js';
import type { Session } from '../src/config.js';
import { createMcpServer } from '../src/mcp/server.js';
import { type Handler, json, mockFetch, noContent, noSleep, service, serviceList } from './helpers.js';

const PANEL = 'https://panel.test';
const WINGS = 'https://node1.panel.test:8080';

const session = (token: string | null = 'agent-token'): Session => ({
    panelUrl: PANEL,
    token,
    tokenFrom: token ? 'config' : null,
    config: {},
    path: '/dev/null',
});

const remoteTools = [
    { name: 'list_services', description: 'List services', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_logs', description: 'Read logs', inputSchema: { type: 'object', properties: { service: { type: 'string' } } } },
];

const mcpEndpoint: Handler = (request) => {
    const message = JSON.parse(request.body ?? '{}') as { id: number; method: string; params: { name?: string } };
    if (message.method === 'tools/list') {
        return json({ jsonrpc: '2.0', id: message.id, result: { tools: remoteTools } });
    }
    return json({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `remote ${message.params.name}` }] },
    });
};

async function connect(fetchImpl: FetchLike, token: string | null = 'agent-token') {
    const server = createMcpServer({
        loadSession: async () => session(token),
        fetch: fetchImpl,
        log: () => undefined,
        local: { sleep: noSleep, followSeconds: 3 },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

function textOf(result: unknown): string {
    return ((result as CallToolResult).content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

let scratch: string;

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aclclouds-mcp-'));
});

after(async () => {
    await rm(scratch, { recursive: true, force: true });
});

describe('MCP server', () => {
    it('lists the remote tools followed by the local tools', async () => {
        const { fetch, calls } = mockFetch({ 'POST /mcp': mcpEndpoint });
        const client = await connect(fetch);

        const { tools } = await client.listTools();

        assert.deepEqual(
            tools.map((tool) => tool.name),
            ['list_services', 'read_logs', 'deploy_directory', 'upload_file', 'download_file'],
        );
        assert.equal(calls[0]?.headers.get('authorization'), 'Bearer agent-token');
    });

    it('forwards remote tools as-is', async () => {
        const { fetch, calls } = mockFetch({ 'POST /mcp': mcpEndpoint });
        const client = await connect(fetch);

        const result = await client.callTool({ name: 'read_logs', arguments: { service: 'abcd1234', lines: 20 } });

        assert.equal(textOf(result), 'remote read_logs');
        const sent = JSON.parse(calls[0]?.body ?? '{}') as { method: string; params: unknown };
        assert.equal(sent.method, 'tools/call');
        assert.deepEqual(sent.params, { name: 'read_logs', arguments: { service: 'abcd1234', lines: 20 } });
    });

    it('still serves the local tools when the remote MCP is unreachable', async () => {
        const failing: FetchLike = async () => {
            throw new Error('connect ECONNREFUSED');
        };
        const client = await connect(failing);

        const { tools } = await client.listTools();
        assert.deepEqual(
            tools.map((tool) => tool.name),
            ['deploy_directory', 'upload_file', 'download_file'],
        );

        const result = (await client.callTool({ name: 'list_services', arguments: {} })) as CallToolResult;
        assert.equal(result.isError, true);
        assert.match(textOf(result), /unreachable/);
    });

    it('asks to sign in when there is no token', async () => {
        const { fetch } = mockFetch({});
        const client = await connect(fetch, null);
        const result = (await client.callTool({ name: 'upload_file', arguments: { service: 'x', local_path: '/tmp/x' } })) as CallToolResult;
        assert.equal(result.isError, true);
        assert.match(textOf(result), /aclclouds login/);
    });

    it('validates local tool arguments', async () => {
        const { fetch } = mockFetch({});
        const client = await connect(fetch);
        const result = (await client.callTool({ name: 'download_file', arguments: { service: 'x' } })) as CallToolResult;
        assert.equal(result.isError, true);
        assert.match(textOf(result), /Invalid arguments/);
    });

    it('download_file writes the file through the signed URL', async () => {
        const { fetch, calls } = mockFetch({
            'GET /api/client': () => json(serviceList([service()])),
            'GET /api/client/servers/abcd1234/files/download': () =>
                json({ object: 'signed_url', attributes: { url: `${WINGS}/download/file?token=jwt` } }),
            [`GET ${WINGS}/download/file`]: () => new Response('level-name=world\n'),
        });
        const client = await connect(fetch);
        const target = join(scratch, 'server.properties');

        const result = (await client.callTool({
            name: 'download_file',
            arguments: { service: 'survival', path: '/server.properties', local_path: target },
        })) as CallToolResult;

        assert.equal(result.isError, undefined);
        assert.equal(await readFile(target, 'utf8'), 'level-name=world\n');
        const download = calls.find((call) => call.url.pathname.endsWith('/files/download'));
        assert.equal(download?.url.searchParams.get('file'), '/server.properties');
        // The Wings URL is signed: the panel token is not sent there.
        const wings = calls.find((call) => call.url.origin === WINGS);
        assert.equal(wings?.headers.get('authorization'), null);
    });

    it('deploy_directory returns the approval link instead of waiting, with a stable request', async () => {
        const project = join(scratch, 'bot');
        await mkdir(project, { recursive: true });
        await writeFile(join(project, 'index.js'), 'console.log(1)');
        await writeFile(join(project, '.gitignore'), 'node_modules/\n');

        const approval = {
            id: 'appr-9',
            status: 'pending',
            action: 'files.deploy',
            summary: 'Clean deployment of /',
            details: [],
            approve_url: `${PANEL}/dashboard/account/agents?approval=appr-9`,
            expires_at: new Date(Date.now() + 900_000).toISOString(),
        };
        const { fetch, calls } = mockFetch({
            'GET /api/client': () => json(serviceList([service({ service_type: 'discord', name: 'Music Bot' })])),
            'GET /api/client/servers/abcd1234/files/upload': () =>
                json({ object: 'signed_url', attributes: { url: `${WINGS}/upload/file?token=jwt` } }),
            [`POST ${WINGS}/upload/file`]: () => new Response(null, { status: 200 }),
            'POST /api/client/servers/abcd1234/files/deploy': () =>
                json({ errors: [{ code: 'approval_required', status: '428', detail: 'Approval needed' }], approval }, 428),
        });
        const client = await connect(fetch);
        const args = { service: 'music bot', path: project, clean: true, keep: ['data'] };

        const first = (await client.callTool({ name: 'deploy_directory', arguments: args })) as CallToolResult;
        const second = (await client.callTool({ name: 'deploy_directory', arguments: args })) as CallToolResult;

        assert.equal(first.isError, undefined);
        assert.match(textOf(first), /Approval required: Clean deployment of \//);
        assert.match(textOf(first), /agents\?approval=appr-9/);
        assert.match(textOf(first), /same arguments/);
        assert.equal(textOf(second), textOf(first));

        const uploads = calls.filter((call) => call.url.origin === WINGS);
        assert.equal(uploads[0]?.url.searchParams.get('directory'), '/');
        const file = uploads[0]?.form?.get('files');
        assert.ok(file instanceof Blob);

        const deploys = calls.filter((call) => call.url.pathname.endsWith('/files/deploy'));
        assert.equal(deploys.length, 2);
        assert.equal(deploys[0]?.body, deploys[1]?.body);
        const body = JSON.parse(deploys[0]?.body ?? '{}') as Record<string, unknown>;
        assert.match(String(body.archive), /^\.aclclouds-deploy-[0-9a-f]{16}\.tar\.gz$/);
        assert.deepEqual({ ...body, archive: undefined }, { archive: undefined, directory: '/', clean: true, keep: ['data'] });
    });

    it('deploy_directory restarts the service and reports its state and new logs', async () => {
        const project = join(scratch, 'game');
        await mkdir(project, { recursive: true });
        await writeFile(join(project, 'server.properties'), 'motd=hi');

        const { fetch, calls } = mockFetch({
            'GET /api/client': () => json(serviceList([service()])),
            'GET /api/client/servers/abcd1234/files/upload': () =>
                json({ object: 'signed_url', attributes: { url: `${WINGS}/upload/file?token=jwt` } }),
            [`POST ${WINGS}/upload/file`]: () => new Response(null, { status: 200 }),
            'POST /api/client/servers/abcd1234/files/deploy': () =>
                json({ object: 'deployment', attributes: { directory: '/', archive: 'a.tar.gz', clean: false, removed: [] } }),
            'POST /api/client/servers/abcd1234/power': () => noContent(),
            'GET /api/client/servers/abcd1234/logs': [
                () => json({ data: ['old line'] }),
                () => json({ data: ['old line', 'Starting server', 'Done (3.2s)!'] }),
            ],
            'GET /api/client/servers/abcd1234/resources': () =>
                json({ object: 'stats', attributes: { current_state: 'running', resources: {} } }),
        });
        const client = await connect(fetch);

        const result = (await client.callTool({ name: 'deploy_directory', arguments: { service: 'abcd1234', path: project } })) as CallToolResult;

        assert.equal(result.isError, undefined, textOf(result));
        const text = textOf(result);
        assert.match(text, /1 files/);
        assert.match(text, /Current state: running/);
        assert.match(text, /Done \(3\.2s\)!/);
        assert.doesNotMatch(text, /old line/);
        const power = calls.find((call) => call.url.pathname.endsWith('/power'));
        assert.deepEqual(JSON.parse(power?.body ?? '{}'), { signal: 'restart' });
    });
});
