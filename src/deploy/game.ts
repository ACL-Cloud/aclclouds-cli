import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiClient } from '../api/client.js';
import { unwrapItem } from '../api/fractal.js';
import type { Service } from '../api/types.js';
import { type FileSelection, createArchive, deployArchiveName } from '../archive.js';
import { servicePath } from '../services.js';
import { remotePath, uploadFile } from '../transfer.js';

export interface GameDeployOptions {
    /** Target directory on the service. */
    directory: string;
    /** Empty the directory first (except `.trash` and `keep`). Needs an approval. */
    clean: boolean;
    keep: string[];
}

export interface DeployResult {
    directory: string;
    archive: string;
    clean: boolean;
    removed: string[];
}

/**
 * Builds the archive, uploads it into the target directory and asks the
 * panel to extract it. The archive name only depends on the files and the
 * options, so a retry after an approval repeats the same request.
 */
export async function deployToGameService(
    client: ApiClient,
    service: Service,
    root: string,
    selection: FileSelection,
    options: GameDeployOptions,
    hooks: { onArchive?: (bytes: number) => void; onUploaded?: () => void } = {},
): Promise<DeployResult> {
    const body = { directory: remotePath(options.directory), clean: options.clean, keep: options.keep };
    const archive = deployArchiveName(selection.files, body);
    const workdir = await mkdtemp(join(tmpdir(), 'aclclouds-'));

    try {
        const archivePath = join(workdir, archive);
        const bytes = await createArchive(root, selection.files, archivePath);
        hooks.onArchive?.(bytes);
        await uploadFile(client, service, archivePath, body.directory, archive);
        hooks.onUploaded?.();
    } finally {
        await rm(workdir, { recursive: true, force: true });
    }

    const result = await client.request({
        method: 'POST',
        path: servicePath(service, '/files/deploy'),
        json: { ...body, archive },
        timeoutMs: 15 * 60_000,
    });
    const attributes = unwrapItem<Partial<DeployResult>>(result) ?? {};
    return {
        directory: attributes.directory ?? body.directory,
        archive,
        clean: attributes.clean ?? options.clean,
        removed: Array.isArray(attributes.removed) ? attributes.removed : [],
    };
}
