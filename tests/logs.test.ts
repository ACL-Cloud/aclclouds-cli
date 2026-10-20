import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { LogFollower, newLogLines } from '../src/logs.js';
import { json, mockFetch, service } from './helpers.js';

describe('newLogLines', () => {
    it('returns everything on the first poll', () => {
        assert.deepEqual(newLogLines([], ['a', 'b']), ['a', 'b']);
    });

    it('returns nothing when the window did not move', () => {
        assert.deepEqual(newLogLines(['a', 'b', 'c'], ['a', 'b', 'c']), []);
    });

    it('returns the lines after the overlap of a sliding window', () => {
        assert.deepEqual(newLogLines(['a', 'b', 'c', 'd'], ['c', 'd', 'e', 'f']), ['e', 'f']);
    });

    it('handles a growing window', () => {
        assert.deepEqual(newLogLines(['a', 'b'], ['a', 'b', 'c']), ['c']);
    });

    it('keeps repeated identical lines', () => {
        assert.deepEqual(newLogLines(['x', 'tick', 'tick'], ['tick', 'tick', 'tick', 'tick']), ['tick', 'tick']);
    });

    it('returns the whole window when nothing overlaps (more lines than the window, or console reset)', () => {
        assert.deepEqual(newLogLines(['a', 'b'], ['c', 'd']), ['c', 'd']);
    });
});

describe('LogFollower', () => {
    it('prints only new lines between polls', async () => {
        const windows = [
            ['boot', 'ready'],
            ['boot', 'ready', 'join alice'],
            ['ready', 'join alice', 'join bob', 'chat hi'],
        ];
        const { fetch, calls } = mockFetch({
            'GET /api/client/servers/abcd1234/logs': windows.map((data) => () => json({ object: 'server_logs', data })),
        });
        const follower = new LogFollower(new ApiClient({ panelUrl: 'https://panel.test', token: 't', fetch }), service());

        assert.deepEqual(await follower.prime(1), ['ready']);
        assert.deepEqual(await follower.poll(), ['join alice']);
        assert.deepEqual(await follower.poll(), ['join bob', 'chat hi']);
        assert.equal(calls[0]?.url.searchParams.get('lines'), '100');
    });
});
