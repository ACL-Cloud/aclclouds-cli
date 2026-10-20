import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike } from '../api/client.js';
import { USER_AGENT } from '../version.js';

const PROTOCOL_VERSION = '2025-06-18';

export class RemoteMcpError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'RemoteMcpError';
    }
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id?: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

/**
 * Client of the panel's remote MCP endpoint (`POST {panel}/mcp`, JSON-RPC 2.0,
 * stateless: `tools/list` and `tools/call` work without `initialize`).
 */
export class RemoteMcp {
    private nextId = 1;
    private readonly endpoint: string;

    constructor(
        panelUrl: string,
        private readonly token: string,
        private readonly fetchImpl: FetchLike = fetch,
    ) {
        this.endpoint = `${panelUrl.replace(/\/+$/, '')}/mcp`;
    }

    async listTools(): Promise<Tool[]> {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
            const result = (await this.call('tools/list', cursor ? { cursor } : {})) as {
                tools?: Tool[];
                nextCursor?: string;
            };
            tools.push(...(result.tools ?? []));
            cursor = result.nextCursor;
            if (!cursor) {
                break;
            }
        }
        return tools;
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
        return (await this.call('tools/call', { name, arguments: args })) as CallToolResult;
    }

    private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = this.nextId++;
        let response: Response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.token}`,
                    'MCP-Protocol-Version': PROTOCOL_VERSION,
                    'User-Agent': USER_AGENT,
                },
                body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
                signal: AbortSignal.timeout(120_000),
            });
        } catch (error) {
            throw new RemoteMcpError(
                `ACLClouds is unreachable (${this.endpoint}): ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        if (response.status === 401) {
            throw new RemoteMcpError('The ACLClouds token was rejected (expired or revoked). Run `npx aclclouds login` again.', 401);
        }

        const text = await response.text();
        const message = parseMessage(text, response.headers.get('content-type') ?? '', id);
        if (!message) {
            throw new RemoteMcpError(
                `The ACLClouds MCP endpoint ${this.endpoint} is not available (HTTP ${response.status}).`,
                response.status,
            );
        }
        if (message.error) {
            throw new RemoteMcpError(`ACLClouds MCP error: ${message.error.message}`, response.status);
        }
        return message.result;
    }
}

/** Reads a JSON-RPC response from a JSON body or from a short SSE stream. */
export function parseMessage(text: string, contentType: string, id: number): JsonRpcResponse | null {
    const candidates: string[] = [];
    if (contentType.includes('text/event-stream')) {
        for (const line of text.split(/\r?\n/)) {
            if (line.startsWith('data:')) {
                candidates.push(line.slice(5).trim());
            }
        }
    } else {
        candidates.push(text);
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as JsonRpcResponse | JsonRpcResponse[];
            const list = Array.isArray(parsed) ? parsed : [parsed];
            const match = list.find((entry) => entry && entry.id === id) ?? list.find((entry) => entry && entry.error);
            if (match) {
                return match;
            }
        } catch {
            // Not JSON: ignore this candidate.
        }
    }
    return null;
}
