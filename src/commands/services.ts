import type { Command } from 'commander';
import { unwrapItem } from '../api/fractal.js';
import type { Resources, Service, VpsStatus } from '../api/types.js';
import { requireClient } from '../context.js';
import { colorState, formatBytes, formatDuration, out, print, printJson, table } from '../output.js';
import { normalizeVpsState } from '../power.js';
import { listServices, resolveService, serviceKind, servicePath, serviceTypeLabel } from '../services.js';

function serviceStatus(service: Service): string {
    if (service.is_suspended) {
        return 'suspended';
    }
    if (service.is_installing) {
        return 'installing';
    }
    return service.status || 'active';
}

async function services(options: { json?: boolean; type?: string }): Promise<void> {
    const client = await requireClient();
    let list = await listServices(client);
    if (options.type) {
        const wanted = options.type.toLowerCase();
        list = list.filter((s) => serviceKind(s) === wanted || serviceTypeLabel(s) === wanted);
    }

    if (options.json) {
        printJson(
            list.map((s) => ({
                identifier: s.identifier,
                uuid: s.uuid,
                name: s.name,
                type: serviceTypeLabel(s),
                kind: serviceKind(s),
                status: serviceStatus(s),
                address: s.connection_addresses?.subdomain || s.connection_addresses?.primary || null,
            })),
        );
        return;
    }

    if (list.length === 0) {
        print('No services.');
        return;
    }
    print(
        table(
            ['ID', 'NAME', 'TYPE', 'STATUS', 'ADDRESS'],
            list.map((s) => [
                s.identifier,
                s.name,
                serviceTypeLabel(s),
                serviceStatus(s) === 'active' ? 'active' : out.yellow(serviceStatus(s)),
                s.connection_addresses?.subdomain || s.connection_addresses?.primary || '-',
            ]),
        ),
    );
}

async function status(query: string, options: { json?: boolean }): Promise<void> {
    const client = await requireClient();
    const service = await resolveService(client, query);
    const kind = serviceKind(service);

    let live: { state: string; cpu?: number; memory?: number; memoryLimit?: number; disk?: number; uptime?: number; error?: string };
    try {
        if (kind === 'vps') {
            const vps = await client.get<VpsStatus>(servicePath(service, '/vps/status'));
            live = {
                state: normalizeVpsState(vps.status),
                cpu: vps.cpu,
                memory: vps.memory?.used,
                memoryLimit: vps.memory?.total,
                uptime: vps.uptime,
            };
        } else {
            const resources = unwrapItem<Resources>(await client.get(servicePath(service, '/resources')));
            live = {
                state: resources.current_state,
                cpu: resources.resources?.cpu_absolute,
                memory: resources.resources?.memory_bytes,
                memoryLimit: service.limits?.memory ? service.limits.memory * 1024 * 1024 : undefined,
                disk: resources.resources?.disk_bytes,
                uptime: resources.resources?.uptime ? Math.floor(resources.resources.uptime / 1000) : undefined,
            };
        }
    } catch (error) {
        live = { state: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }

    if (options.json) {
        printJson({ service, live });
        return;
    }

    const rows: [string, string][] = [
        ['Name', `${service.name} (${service.identifier})`],
        ['Type', serviceTypeLabel(service)],
        ['State', colorState(live.state) + (live.error ? out.dim(` (${live.error})`) : '')],
        ['Status', serviceStatus(service)],
        ['Address', service.connection_addresses?.subdomain || service.connection_addresses?.primary || '-'],
    ];
    if (kind === 'vps') {
        rows.push(['SSH', service.vps?.ipv4 ? `${service.vps.username || 'root'}@${service.vps.ipv4}` : '-']);
        rows.push(['OS', service.vps?.os_template || '-']);
    }
    if (live.cpu !== undefined) {
        rows.push(['CPU', `${Number(live.cpu).toFixed(1)} %`]);
    }
    if (live.memory !== undefined) {
        rows.push(['Memory', `${formatBytes(live.memory)}${live.memoryLimit ? ` / ${formatBytes(live.memoryLimit)}` : ''}`]);
    }
    if (live.disk !== undefined) {
        rows.push(['Disk', formatBytes(live.disk)]);
    }
    if (live.uptime) {
        rows.push(['Uptime', formatDuration(live.uptime)]);
    }
    if (service.plan?.name) {
        rows.push(['Plan', service.plan.name]);
    }
    if (service.expires_at) {
        rows.push(['Renewal', new Date(service.expires_at).toLocaleString()]);
    }

    for (const [label, value] of rows) {
        print(`${out.dim(label.padEnd(8))} ${value}`);
    }
}

export function registerServiceCommands(program: Command): void {
    program
        .command('services')
        .alias('ls')
        .description('List your services (game servers, bots, VPS)')
        .option('--type <type>', 'only one kind: game, bot, vps, or a game (minecraft...)')
        .option('--json', 'JSON output')
        .action((options: { json?: boolean; type?: string }) => services(options));

    program
        .command('status')
        .argument('<service>', 'identifier, uuid or name')
        .description('Show a service with its live state and resources')
        .option('--json', 'JSON output')
        .action((query: string, options: { json?: boolean }) => status(query, options));
}
