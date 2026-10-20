import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    type CallToolResult,
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike } from '../api/client.js';
import { ApiClient } from '../api/client.js';
import { type Session, loadSession } from '../config.js';
import { CliError, ExitCode } from '../errors.js';
import { VERSION } from '../version.js';
import { LOCAL_TOOLS, LOCAL_TOOL_NAMES, type LocalToolContext, callLocalTool } from './local-tools.js';
import { RemoteMcp } from './remote.js';

const INSTRUCTIONS = [
    'Tools to manage the ACLClouds services (game servers, Discord bots, VPS) of the signed-in user.',
    'Identify a service by its short identifier, uuid or name (list_services).',
    'deploy_directory, upload_file and download_file work on the local disk of the user.',
    'When a result says an approval is required, give the link to the user and call the same tool again',
    'with exactly the same arguments once they have approved it.',
].join(' ');

export interface McpDependencies {
    loadSession?: () => Promise<Session>;
    fetch?: FetchLike;
    /** Logger for diagnostics: stderr only, stdout carries the protocol. */
    log?: (message: string) => void;
    local?: Partial<LocalToolContext>;
}

function errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

const NOT_SIGNED_IN =
    'Not signed in to ACLClouds. Ask the user to run `npx aclclouds login` in a terminal (or set ACLCLOUDS_TOKEN), then retry.';

/**
 * Stdio MCP server: relays the tools of the remote ACLClouds MCP endpoint and
 * adds local tools that read or write the user's disk.
 */
export function createMcpServer(deps: McpDependencies = {}): Server {
    const getSession = deps.loadSession ?? (() => loadSession());
    const log = deps.log ?? ((message: string) => process.stderr.write(`[aclclouds mcp] ${message}\n`));

    const signedIn = async (): Promise<Session & { token: string }> => {
        const session = await getSession();
        if (!session.token) {
            throw new CliError(NOT_SIGNED_IN, ExitCode.AUTH);
        }
        return session as Session & { token: string };
    };

    const localContext: LocalToolContext = {
        getClient: async () => {
            const session = await signedIn();
            return new ApiClient({ panelUrl: session.panelUrl, token: session.token, fetch: deps.fetch });
        },
        ...deps.local,
    };

    const server = new Server({ name: 'aclclouds', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        let remoteTools: Tool[] = [];
        try {
            const session = await signedIn();
            remoteTools = await new RemoteMcp(session.panelUrl, session.token, deps.fetch).listTools();
        } catch (error) {
            log(`remote tools unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { tools: [...remoteTools.filter((tool) => !LOCAL_TOOL_NAMES.has(tool.name)), ...LOCAL_TOOLS] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
        const { name, arguments: args } = request.params;
        if (LOCAL_TOOL_NAMES.has(name)) {
            return callLocalTool(name, args ?? {}, localContext);
        }

        let session: Session & { token: string };
        try {
            session = await signedIn();
        } catch (error) {
            return errorResult(error instanceof Error ? error.message : NOT_SIGNED_IN);
        }

        try {
            return await new RemoteMcp(session.panelUrl, session.token, deps.fetch).callTool(name, args ?? {});
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log(`tools/call ${name} failed: ${reason}`);
            return errorResult(
                `${reason}\nThe ACLClouds remote tools are unavailable right now; the local tools (deploy_directory, upload_file, download_file) still work.`,
            );
        }
    });

    return server;
}

export async function runMcpServer(): Promise<void> {
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
    process.stderr.write(`[aclclouds mcp] v${VERSION} ready on stdio\n`);
}
