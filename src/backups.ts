import type { ApiClient } from './api/client.js';
import { unwrapItem, unwrapList } from './api/fractal.js';
import type { Backup, Service } from './api/types.js';
import { type Sleep, sleep as defaultSleep } from './approvals.js';
import { ApiError, CliError, ExitCode } from './errors.js';
import { serviceKind, servicePath } from './services.js';

export function requireWingsService(service: Service, what: string): void {
    if (serviceKind(service) === 'vps') {
        throw new CliError(
            `${what} is available for game servers and bots, not for a VPS.`,
            ExitCode.USAGE,
            'On a VPS, use `aclclouds exec` or SSH, and the snapshots of the panel.',
        );
    }
}

export async function listBackups(client: ApiClient, service: Service): Promise<{ backups: Backup[]; count: number }> {
    const page = unwrapList<Backup>(await client.get(servicePath(service, '/backups'), { per_page: 50 }));
    const count = typeof page.meta?.backup_count === 'number' ? page.meta.backup_count : page.items.length;
    return { backups: page.items, count };
}

export async function createBackup(client: ApiClient, service: Service, name?: string): Promise<Backup> {
    return unwrapItem<Backup>(await client.post(servicePath(service, '/backups'), name ? { name } : {}));
}

/** Waits until the backup is completed (successful or failed). */
export async function waitForBackup(
    client: ApiClient,
    service: Service,
    uuid: string,
    options: { timeoutMs?: number; sleep?: Sleep; now?: () => number } = {},
): Promise<Backup> {
    const wait = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
    while (now() < deadline) {
        await wait(3000);
        const backup = unwrapItem<Backup>(await client.get(servicePath(service, `/backups/${uuid}`)));
        if (backup.completed_at) {
            return backup;
        }
    }
    throw new CliError('Timed out waiting for the backup to finish.', ExitCode.TIMEOUT);
}

/**
 * Why a backup cannot be created, when it is a limit of the offer rather
 * than an error: limit reached, or no backups on free offers.
 */
export function backupUnavailableReason(error: unknown): string | null {
    if (!(error instanceof ApiError)) {
        return null;
    }
    if (error.code === 'TooManyBackupsException') {
        return `${error.message} Delete an old backup (panel or \`aclclouds backups ls\`) to make room.`;
    }
    if (error.status === 403 && /sauvegarde|backup/i.test(error.message) && error.code !== 'insufficient_scope') {
        return error.message;
    }
    return null;
}

export function matchBackup(backups: Backup[], query: string): Backup {
    const lower = query.toLowerCase();
    const exact = backups.find((backup) => backup.uuid.toLowerCase() === lower);
    if (exact) {
        return exact;
    }
    const candidates = backups.filter(
        (backup) => backup.uuid.toLowerCase().startsWith(lower) || backup.name.toLowerCase() === lower,
    );
    if (candidates.length === 1) {
        return candidates[0] as Backup;
    }
    throw new CliError(
        candidates.length === 0 ? `No backup matches "${query}".` : `"${query}" matches ${candidates.length} backups.`,
        ExitCode.NOT_FOUND,
        'Run `aclclouds backups ls <service>` and use the full id.',
    );
}
