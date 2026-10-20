import type { ApiClient } from './api/client.js';
import { unwrapList } from './api/fractal.js';
import type { Service } from './api/types.js';
import { CliError, ExitCode } from './errors.js';

export type ServiceKind = 'vps' | 'bot' | 'game';

export function serviceKind(service: Pick<Service, 'service_type'>): ServiceKind {
    if (service.service_type === 'proxmox') {
        return 'vps';
    }
    if (service.service_type === 'discord') {
        return 'bot';
    }
    return 'game';
}

/** Internal panel types that mean nothing to a customer. */
const GENERIC_TYPES: Record<string, string> = { pterodactyl: 'app', tool: 'tool', ai: 'ai' };

/** Human label of the service type: `vps`, `bot`, the game (`minecraft`, ...) or `app`. */
export function serviceTypeLabel(service: Pick<Service, 'service_type'>): string {
    const kind = serviceKind(service);
    if (kind !== 'game') {
        return kind;
    }
    const type = service.service_type || 'game';
    return GENERIC_TYPES[type] ?? type;
}

export function servicePath(service: Pick<Service, 'identifier'>, suffix = ''): string {
    return `/api/client/servers/${encodeURIComponent(service.identifier)}${suffix}`;
}

/** Every service the token can see, all pages included. */
export async function listServices(client: ApiClient): Promise<Service[]> {
    const services: Service[] = [];
    for (let page = 1; page <= 50; page++) {
        const { items, pagination } = unwrapList<Service>(await client.get('/api/client', { per_page: 100, page }));
        services.push(...items);
        if (!pagination || pagination.current_page >= pagination.total_pages || items.length === 0) {
            break;
        }
    }
    return services;
}

function describe(service: Service): string {
    return `${service.identifier}  ${service.name} (${serviceTypeLabel(service)})`;
}

/**
 * Finds a service by short identifier, uuid, or name (case-insensitive).
 * An exact name wins over a partial one; several matches are reported with candidates.
 */
export function matchService(services: Service[], query: string): Service {
    const wanted = query.trim();
    const lower = wanted.toLowerCase();
    if (wanted === '') {
        throw new CliError('No service given.', ExitCode.USAGE, 'Run `aclclouds services` to list them.');
    }

    const byId = services.find((s) => s.identifier.toLowerCase() === lower || s.uuid.toLowerCase() === lower);
    if (byId) {
        return byId;
    }

    for (const candidates of [
        services.filter((s) => s.name.toLowerCase() === lower),
        services.filter((s) => s.uuid.toLowerCase().startsWith(lower) && lower.length >= 4),
        services.filter((s) => s.name.toLowerCase().includes(lower)),
    ]) {
        if (candidates.length === 1) {
            return candidates[0] as Service;
        }
        if (candidates.length > 1) {
            throw new CliError(
                `"${query}" matches ${candidates.length} services:\n${candidates.map((s) => `  ${describe(s)}`).join('\n')}`,
                ExitCode.NOT_FOUND,
                'Use the identifier (first column) to pick one.',
            );
        }
    }

    throw new CliError(
        services.length === 0
            ? `No service found for "${query}": this token cannot see any service.`
            : `No service matches "${query}".`,
        ExitCode.NOT_FOUND,
        'Run `aclclouds services` to list the services this token can manage.',
    );
}

export async function resolveService(client: ApiClient, query: string): Promise<Service> {
    return matchService(await listServices(client), query);
}
