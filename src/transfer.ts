import * as fs from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { type ApiClient, readBody, toApiError } from './api/client.js';
import { unwrapItem } from './api/fractal.js';
import type { Service } from './api/types.js';
import { CliError, ExitCode } from './errors.js';
import { servicePath } from './services.js';

const TRANSFER_TIMEOUT_MS = 30 * 60_000;

/** `/a/b` form of a path on the service (no trailing slash, `..` refused). */
export function remotePath(path: string | undefined): string {
    const value = `/${(path ?? '').replace(/\\/g, '/')}`;
    const normalized = posix.normalize(value).replace(/\/+$/, '');
    if (value.split('/').includes('..')) {
        throw new CliError(`Invalid path on the service: ${path}`, ExitCode.USAGE);
    }
    return normalized === '' ? '/' : normalized;
}

async function fileBlob(path: string): Promise<Blob> {
    const openAsBlob = (fs as unknown as { openAsBlob?: (path: string) => Promise<Blob> }).openAsBlob;
    if (typeof openAsBlob === 'function') {
        return openAsBlob(path);
    }
    return new Blob([await readFile(path)]);
}

async function signedUrl(client: ApiClient, path: string, query?: Record<string, string>): Promise<string> {
    const { url } = unwrapItem<{ url?: string }>(await client.get(path, query));
    if (!url) {
        throw new CliError('The panel did not return a transfer URL.', ExitCode.ERROR);
    }
    return url;
}

/**
 * Uploads a local file into `directory` on a game server or bot, through the
 * signed Wings URL (multipart field `files`, query `directory`).
 */
export async function uploadFile(
    client: ApiClient,
    service: Service,
    localPath: string,
    directory: string,
    name: string = basename(localPath),
): Promise<void> {
    const info = await stat(localPath).catch(() => null);
    if (!info?.isFile()) {
        throw new CliError(`${localPath} is not a file.`, ExitCode.USAGE);
    }

    const url = new URL(await signedUrl(client, servicePath(service, '/files/upload')));
    url.searchParams.set('directory', remotePath(directory));

    const form = new FormData();
    form.append('files', await fileBlob(localPath), name);

    let response: Response;
    try {
        response = await client.fetch(url.toString(), {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        });
    } catch (error) {
        throw new CliError(`Upload failed: ${error instanceof Error ? error.message : String(error)}`, ExitCode.ERROR);
    }

    if (!response.ok) {
        if (response.status === 413) {
            throw new CliError(
                'The file is larger than the upload limit of this service.',
                ExitCode.ERROR,
                'Exclude large files with .aclignore, or deploy smaller parts.',
            );
        }
        throw toApiError(response.status, 'POST upload', await readBody(response));
    }
}

/** Downloads a file of a game server or bot to `localPath` (a file, or an existing directory). */
export async function downloadFile(
    client: ApiClient,
    service: Service,
    path: string,
    localPath: string,
): Promise<{ path: string; bytes: number }> {
    const source = remotePath(path);
    const url = await signedUrl(client, servicePath(service, '/files/download'), { file: source });

    const localInfo = await stat(localPath).catch(() => null);
    const target = localInfo?.isDirectory() ? join(localPath, posix.basename(source)) : localPath;

    let response: Response;
    try {
        response = await client.fetch(url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
    } catch (error) {
        throw new CliError(`Download failed: ${error instanceof Error ? error.message : String(error)}`, ExitCode.ERROR);
    }
    if (!response.ok || !response.body) {
        throw toApiError(response.status, 'GET download', await readBody(response));
    }

    const temporary = `${target}.aclclouds-part`;
    try {
        await pipeline(
            Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
            fs.createWriteStream(temporary),
        );
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
    return { path: target, bytes: (await stat(target)).size };
}
