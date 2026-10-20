import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editDistance, suggestCommand } from '../src/suggest.js';

const commands = ['login', 'logout', 'services', 'status', 'restart', 'logs', 'help'];

test('computes edit distance', () => {
    assert.equal(editDistance('kitten', 'sitting'), 3);
    assert.equal(editDistance('', 'abc'), 3);
    assert.equal(editDistance('same', 'same'), 0);
});

test('suggests the close command for a typo', () => {
    assert.equal(suggestCommand('logn', commands), 'login');
    assert.equal(suggestCommand('servces', commands), 'services');
    assert.equal(suggestCommand('Restart', commands), 'restart');
});

test('suggests nothing for an unrelated word', () => {
    assert.equal(suggestCommand('blabla', commands), undefined);
    assert.equal(suggestCommand('zzz', commands), undefined);
});
