import { basename } from 'node:path';
import { posix } from 'node:path';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.js';
import { unwrapList } from '../api/fractal.js';
import type { FileObject, Service } from '../api/types.js';
import { requireWingsService } from '../backups.js';
import { requireClient } from '../context.js';
import { CliError, ExitCode } from '../errors.js';
import { confirm, formatBytes, isInteractive, out, print, printJson, success, table } from '../output.js';
import { resolveService, servicePath } from '../services.js';
import { downloadFile, remotePath, uploadFile } from '../transfer.js';

async function fileService(query: string): Promise<{ client: ApiClient; service: Service }> {
    const client = await requireClient();
    const service = await resolveService(client, query);
    requireWingsService(service, 'The file manager');
    return { client, service };
}

async function listDirectory(client: ApiClient, service: Service, directory: string): Promise<FileObject[]> {
    return unwrapList<FileObject>(await client.get(servicePath(service, '/files/list'), { directory: remotePath(directory) }))
        .items;
}

async function ls(query: string, path: string | undefined, options: { json?: boolean }): Promise<void> {
    const { client, service } = await fileService(query);
    const files = await listDirectory(client, service, path ?? '/');
    files.sort((a, b) => Number(a.is_file) - Number(b.is_file) || a.name.localeCompare(b.name));

    if (options.json) {
        printJson(files);
        return;
    }
    if (files.length === 0) {
        print('(empty)');
        return;
    }
    print(
        table(
            ['NAME', 'SIZE', 'MODIFIED'],
            files.map((file) => [
                file.is_file ? file.name : out.blue(`${file.name}/`),
                file.is_file ? formatBytes(file.size) : '-',
                file.modified_at ? new Date(file.modified_at).toLocaleString() : '-',
            ]),
        ),
    );
}

async function cat(query: string, path: string): Promise<void> {
    const { client, service } = await fileService(query);
    const content = await client.request<string>({
        method: 'GET',
        path: servicePath(service, '/files/contents'),
        query: { file: remotePath(path) },
        raw: true,
    });
    process.stdout.write(content ?? '');
}

async function put(query: string, local: string, remote: string | undefined): Promise<void> {
    const { client, service } = await fileService(query);
    let directory = '/';
    let name = basename(local);

    if (remote && !remote.endsWith('/')) {
        const target = remotePath(remote);
        const parent = posix.dirname(target);
        const siblings = await listDirectory(client, service, parent).catch(() => [] as FileObject[]);
        const existing = siblings.find((file) => file.name === posix.basename(target));
        if (existing && !existing.is_file) {
            directory = target;
        } else {
            directory = parent;
            name = posix.basename(target);
        }
    } else if (remote) {
        directory = remotePath(remote);
    }

    await uploadFile(client, service, local, directory, name);
    success(`Uploaded ${local} to ${service.name}:${posix.join(directory, name)}.`);
}

async function get(query: string, remote: string, local: string | undefined): Promise<void> {
    const { client, service } = await fileService(query);
    const result = await downloadFile(client, service, remote, local ?? '.');
    success(`Downloaded ${remotePath(remote)} to ${result.path} (${formatBytes(result.bytes)}).`);
}

async function rm(query: string, paths: string[], options: { yes?: boolean }): Promise<void> {
    const { client, service } = await fileService(query);
    const groups = new Map<string, string[]>();
    for (const path of paths.map(remotePath)) {
        if (path === '/') {
            throw new CliError('Refusing to delete the root directory.', ExitCode.USAGE);
        }
        const root = posix.dirname(path);
        groups.set(root, [...(groups.get(root) ?? []), posix.basename(path)]);
    }

    if (!options.yes && isInteractive()) {
        if (!(await confirm(`Delete ${paths.length} item(s) on ${service.name}?`))) {
            throw new CliError('Cancelled.', ExitCode.ERROR);
        }
    }

    for (const [root, files] of groups) {
        await client.post(servicePath(service, '/files/delete'), { root, files });
    }
    success(`Deleted ${paths.length} item(s) on ${service.name}.`);
}

async function mkdir(query: string, path: string): Promise<void> {
    const { client, service } = await fileService(query);
    const target = remotePath(path);
    await client.post(servicePath(service, '/files/create-folder'), { root: posix.dirname(target), name: posix.basename(target) });
    success(`Created ${target} on ${service.name}.`);
}

async function mv(query: string, from: string, to: string): Promise<void> {
    const { client, service } = await fileService(query);
    const source = remotePath(from);
    const destination = to.endsWith('/') ? posix.join(remotePath(to), posix.basename(source)) : remotePath(to);
    await client.request({
        method: 'PUT',
        path: servicePath(service, '/files/rename'),
        json: { root: '/', files: [{ from: source.slice(1), to: destination.slice(1) }] },
    });
    success(`Moved ${source} to ${destination} on ${service.name}.`);
}

export function registerFileCommands(program: Command): void {
    const files = program.command('files').description('Manage the files of a game server or bot');

    files
        .command('ls')
        .argument('<service>', 'identifier, uuid or name')
        .argument('[path]', 'directory', '/')
        .description('List a directory')
        .option('--json', 'JSON output')
        .action((query: string, path: string, options: { json?: boolean }) => ls(query, path, options));

    files
        .command('cat')
        .argument('<service>')
        .argument('<path>', 'file on the service')
        .description('Print a file')
        .action((query: string, path: string) => cat(query, path));

    files
        .command('put')
        .argument('<service>')
        .argument('<local>', 'local file')
        .argument('[remote]', 'target directory (ending with /) or file path', '/')
        .description('Upload a local file')
        .action((query: string, local: string, remote: string) => put(query, local, remote));

    files
        .command('get')
        .argument('<service>')
        .argument('<remote>', 'file on the service')
        .argument('[local]', 'local file or directory', '.')
        .description('Download a file')
        .action((query: string, remote: string, local: string) => get(query, remote, local));

    files
        .command('rm')
        .argument('<service>')
        .argument('<paths...>', 'files or directories on the service')
        .description('Delete files (the account holder may have to approve it in the panel)')
        .option('-y, --yes', 'do not ask for confirmation')
        .action((query: string, paths: string[], options: { yes?: boolean }) => rm(query, paths, options));

    files
        .command('mkdir')
        .argument('<service>')
        .argument('<path>', 'directory to create')
        .description('Create a directory')
        .action((query: string, path: string) => mkdir(query, path));

    files
        .command('mv')
        .argument('<service>')
        .argument('<from>', 'source path')
        .argument('<to>', 'destination path (ending with / to move into a directory)')
        .description('Move or rename a file or directory')
        .action((query: string, from: string, to: string) => mv(query, from, to));
}
