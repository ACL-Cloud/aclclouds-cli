import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { CliError, ExitCode } from '../src/errors.js';
import { listServices, matchService, serviceKind } from '../src/services.js';
import { json, mockFetch, service, serviceList } from './helpers.js';

const services = [
    service({ identifier: 'aaaa1111', uuid: 'aaaa1111-1111-4111-8111-111111111111', name: 'Survival' }),
    service({ identifier: 'bbbb2222', uuid: 'bbbb2222-2222-4222-8222-222222222222', name: 'Survival Creative' }),
    service({ identifier: 'cccc3333', uuid: 'cccc3333-3333-4333-8333-333333333333', name: 'Music Bot', service_type: 'discord' }),
    service({ identifier: 'dddd4444', uuid: 'dddd4444-4444-4444-8444-444444444444', name: 'Web VPS', service_type: 'proxmox' }),
];

describe('matchService', () => {
    it('finds a service by short identifier or uuid', () => {
        assert.equal(matchService(services, 'cccc3333').name, 'Music Bot');
        assert.equal(matchService(services, 'DDDD4444-4444-4444-8444-444444444444').name, 'Web VPS');
    });

    it('prefers an exact case-insensitive name over partial matches', () => {
        assert.equal(matchService(services, 'survival').identifier, 'aaaa1111');
    });

    it('accepts a unique partial name', () => {
        assert.equal(matchService(services, 'music').identifier, 'cccc3333');
    });

    it('accepts a uuid prefix', () => {
        assert.equal(matchService(services, 'bbbb2222-22').identifier, 'bbbb2222');
    });

    it('lists the candidates when the name is ambiguous', () => {
        assert.throws(
            () => matchService(services, 'surv'),
            (error: unknown) =>
                error instanceof CliError &&
                error.exitCode === ExitCode.NOT_FOUND &&
                error.message.includes('aaaa1111') &&
                error.message.includes('bbbb2222'),
        );
    });

    it('explains how to list services when nothing matches', () => {
        assert.throws(
            () => matchService(services, 'nope'),
            (error: unknown) => error instanceof CliError && Boolean(error.hint?.includes('aclclouds services')),
        );
    });
});

describe('serviceKind', () => {
    it('maps service types', () => {
        assert.equal(serviceKind({ service_type: 'proxmox' }), 'vps');
        assert.equal(serviceKind({ service_type: 'discord' }), 'bot');
        assert.equal(serviceKind({ service_type: 'minecraft' }), 'game');
        assert.equal(serviceKind({ service_type: null }), 'game');
    });
});

describe('listServices', () => {
    it('follows the pagination', async () => {
        const { fetch, calls } = mockFetch({
            'GET /api/client': (request) =>
                request.url.searchParams.get('page') === '1'
                    ? json(serviceList(services.slice(0, 2), 1, 2))
                    : json(serviceList(services.slice(2), 2, 2)),
        });
        const client = new ApiClient({ panelUrl: 'https://panel.test', token: 'secret', fetch });

        const result = await listServices(client);

        assert.deepEqual(
            result.map((s) => s.identifier),
            ['aaaa1111', 'bbbb2222', 'cccc3333', 'dddd4444'],
        );
        assert.equal(calls.length, 2);
        assert.equal(calls[0]?.headers.get('authorization'), 'Bearer secret');
        assert.equal(calls[0]?.url.searchParams.get('per_page'), '100');
    });
});
