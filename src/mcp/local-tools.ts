import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ApiClient } from '../api/client.js';
import { collectFiles } from '../archive.js';
import { requireWingsService } from '../backups.js';
import { deployToGameService } from '../deploy/game.js';
import { deployToVps } from '../deploy/vps.js';
import { ApiError, type ApprovalInfo, describeError } from '../errors.js';
import { LogFollower } from '../logs.js';
import { formatBytes } from '../output.js';
import { getState, sendPower } from '../power.js';
import { resolveService, serviceKind } from '../services.js';
import { downloadFile, uploadFile } from '../transfer.js';

/** Tools served by `aclclouds mcp` itself: they read or write the user's local disk. */
export const LOCAL_TOOLS: Tool[] = [
    {
        name: 'deploy_directory',
        description:
            'Deploy a local directory to an ACLClouds service. Game servers and bots: the files (respecting .gitignore, ' +
            '.aclignore; .git, node_modules, __pycache__, .venv excluded; .env included) are archived, uploaded and ' +
            'extracted into `directory`, then the service is restarted and its state and last logs are returned. ' +
            'VPS: synchronized with rsync over SSH into `directory` (required, e.g. /root/app). ' +
            '`clean: true` first removes the existing files and needs the approval of the account holder. ' +
            'Call create_backup first if a restore point is wanted.',
        inputSchema: {
            type: 'object',
            properties: {
                service: { type: 'string', description: 'Service identifier, uuid or name.' },
                path: { type: 'string', description: 'Local directory to deploy (absolute, or relative to the working directory).' },
                directory: { type: 'string', description: 'Target directory on the service. Default "/" (required for a VPS).' },
                clean: { type: 'boolean', description: 'Remove the existing files of the target directory first. Default false.' },
                keep: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Names kept by a clean deployment (e.g. world, .env).',
                },
                restart: { type: 'boolean', description: 'Restart the service after deploying (game servers and bots). Default true.' },
            },
            required: ['service', 'path'],
        },
    },
    {
        name: 'upload_file',
        description: 'Upload a local file into a directory of a game server or bot (any size up to the service upload limit).',
        inputSchema: {
            type: 'object',
            properties: {
                service: { type: 'string', description: 'Service identifier, uuid or name.' },
                local_path: { type: 'string', description: 'Local file to upload.' },
                directory: { type: 'string', description: 'Target directory on the service. Default "/".' },
            },
            required: ['service', 'local_path'],
        },
    },
    {
        name: 'download_file',
        description: 'Download a file of a game server or bot to the local disk.',
        inputSchema: {
            type: 'object',
            properties: {
                service: { type: 'string', description: 'Service identifier, uuid or name.' },
                path: { type: 'string', description: 'File path on the service, e.g. /logs/latest.log.' },
                local_path: { type: 'string', description: 'Local destination file or existing directory.' },
            },
            required: ['service', 'path', 'local_path'],
        },
    },
];

export const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((tool) => tool.name));

const schemas = {
    deploy_directory: z.object({
        service: z.string().min(1),
        path: z.string().min(1),
        directory: z.string().optional(),
        clean: z.boolean().optional(),
        keep: z.array(z.string()).optional(),
        restart: z.boolean().optional(),
    }),
    upload_file: z.object({
        service: z.string().min(1),
        local_path: z.string().min(1),
        directory: z.string().optional(),
    }),
    download_file: z.object({
        service: z.string().min(1),
        path: z.string().min(1),
        local_path: z.string().min(1),
    }),
};

export interface LocalToolContext {
    /** Client without interactive approvals: a 428 becomes a result for the model. */
    getClient(): Promise<ApiClient>;
    /** Pause used while following logs after a restart (tests use a no-op). */
    sleep?: (ms: number) => Promise<void>;
    followSeconds?: number;
}

function text(value: string, isError = false): CallToolResult {
    return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function localPath(path: string): string {
    return resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
}

export function approvalResult(tool: string, approval: ApprovalInfo): CallToolResult {
    return text(
        [
            `Approval required: ${approval.summary || approval.action}.`,
            `Ask the user to approve it in the ACLClouds panel: ${approval.approve_url} (expires ${approval.expires_at}).`,
            `Once approved, call ${tool} again with exactly the same arguments. Do not change them, or a new approval will be needed.`,
        ].join('\n'),
    );
}

export async function callLocalTool(name: string, args: unknown, context: LocalToolContext): Promise<CallToolResult> {
    try {
        switch (name) {
            case 'deploy_directory':
                return await deployDirectory(schemas.deploy_directory.parse(args ?? {}), context);
            case 'upload_file':
                return await uploadLocalFile(schemas.upload_file.parse(args ?? {}), context);
            case 'download_file':
                return await downloadRemoteFile(schemas.download_file.parse(args ?? {}), context);
            default:
                return text(`Unknown local tool: ${name}`, true);
        }
    } catch (error) {
        if (error instanceof ApiError && error.isApprovalRequired && error.approval) {
            return approvalResult(name, error.approval);
        }
        if (error instanceof z.ZodError) {
            return text(`Invalid arguments for ${name}: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, true);
        }
        const described = describeError(error);
        return text(described.hint ? `${described.message}\n${described.hint}` : described.message, true);
    }
}

async function deployDirectory(
    args: z.infer<typeof schemas.deploy_directory>,
    context: LocalToolContext,
): Promise<CallToolResult> {
    const client = await context.getClient();
    const service = await resolveService(client, args.service);
    const root = localPath(args.path);
    const selection = await collectFiles(root);
    const lines = [`${selection.files.length} files (${formatBytes(selection.totalBytes)}) from ${root} to ${service.name}.`];
    if (selection.envFiles.length > 0) {
        lines.push(`Note: ${selection.envFiles.join(', ')} included (add to .aclignore to exclude).`);
    }

    if (serviceKind(service) === 'vps') {
        const result = await deployToVps(
            root,
            service,
            selection,
            { path: args.directory ?? '', clean: args.clean ?? false, keep: args.keep ?? [], batch: true },
            true,
        );
        lines.push(`Synchronized to ${args.directory} over SSH.`);
        if (result.output.trim()) {
            lines.push(result.output.trim());
        }
        return text(lines.join('\n'));
    }

    const deployed = await deployToGameService(client, service, root, selection, {
        directory: args.directory ?? '/',
        clean: args.clean ?? false,
        keep: args.keep ?? [],
    });
    lines.push(
        `Extracted into ${deployed.directory}${deployed.clean ? ` (clean: ${deployed.removed.length} entries removed first)` : ''}.`,
    );

    if (args.restart === false) {
        return text(lines.join('\n'));
    }

    const follower = new LogFollower(client, service);
    await follower.prime().catch(() => []);
    await sendPower(client, service, 'restart');
    const logs: string[] = [];
    const wait = context.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    for (let elapsed = 0; elapsed < (context.followSeconds ?? 15); elapsed += 3) {
        await wait(3000);
        logs.push(...(await follower.poll().catch(() => [])));
    }
    const state = await getState(client, service).catch(() => 'unknown');
    lines.push(`Restarted. Current state: ${state}.`);
    if (logs.length > 0) {
        lines.push('Console output since the restart (last 40 lines):', ...logs.slice(-40));
    }
    return text(lines.join('\n'));
}

async function uploadLocalFile(args: z.infer<typeof schemas.upload_file>, context: LocalToolContext): Promise<CallToolResult> {
    const client = await context.getClient();
    const service = await resolveService(client, args.service);
    requireWingsService(service, 'File upload');
    const source = localPath(args.local_path);
    await uploadFile(client, service, source, args.directory ?? '/');
    return text(`Uploaded ${source} to ${service.name}:${args.directory ?? '/'}.`);
}

async function downloadRemoteFile(
    args: z.infer<typeof schemas.download_file>,
    context: LocalToolContext,
): Promise<CallToolResult> {
    const client = await context.getClient();
    const service = await resolveService(client, args.service);
    requireWingsService(service, 'File download');
    const result = await downloadFile(client, service, args.path, localPath(args.local_path));
    return text(`Downloaded ${service.name}:${args.path} to ${result.path} (${formatBytes(result.bytes)}).`);
}
