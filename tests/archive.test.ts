import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { list as listTar } from 'tar';
import { collectFiles, createArchive, deployArchiveName } from '../src/archive.js';
import { rsyncExcludes } from '../src/deploy/vps.js';

let root: string;
let scratch: string;

async function put(path: string, content = 'x'): Promise<void> {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
}

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aclclouds-test-'));
    root = join(scratch, 'project');
    await put('index.js', 'console.log("hi")');
    await put('package.json', '{}');
    await put('.env', 'TOKEN=secret');
    await put('.git/config');
    await put('node_modules/discord.js/index.js');
    await put('src/__pycache__/main.cpython-312.pyc');
    await put('.venv/bin/python');
    await put('.DS_Store');
    await put('src/main.py');
    await put('debug.log');
    await put('keep.log');
    await put('dist/bundle.js');
    await put('build/out.js');
    await put('@scope/file.txt');
    await put('.gitignore', '*.log\ndist/\nbuild/\n');
    // .aclignore re-includes what git ignores and excludes more.
    await put('.aclignore', '!keep.log\n!dist/\nsecrets/\n');
    await put('secrets/key.pem');
    await put('sub/.gitignore', 'local.txt\n');
    await put('sub/local.txt');
    await put('sub/shared.txt');
    await symlink(join(root, 'index.js'), join(root, 'link.js'));
});

after(async () => {
    await rm(scratch, { recursive: true, force: true });
});

describe('collectFiles', () => {
    it('applies the default ignores, .gitignore (nested) and .aclignore', async () => {
        const selection = await collectFiles(root);
        assert.deepEqual(
            selection.files.map((file) => file.path),
            [
                '.aclignore',
                '.env',
                '.gitignore',
                '@scope/file.txt',
                'dist/bundle.js',
                'index.js',
                'keep.log',
                'package.json',
                'src/main.py',
                'sub/.gitignore',
                'sub/shared.txt',
            ],
        );
        assert.deepEqual(selection.envFiles, ['.env']);
        assert.deepEqual(selection.symlinks, ['link.js']);
        for (const ignored of ['.git/', 'node_modules/', '.venv/', '.DS_Store', 'build/', 'debug.log', 'secrets/', 'src/__pycache__/', 'sub/local.txt']) {
            assert.ok(selection.ignored.includes(ignored), `${ignored} should be ignored`);
        }
        assert.equal(
            selection.totalBytes,
            selection.files.reduce((sum, file) => sum + file.size, 0),
        );
    });

    it('builds a tar.gz with exactly the selected files', async () => {
        const selection = await collectFiles(root);
        const archive = join(scratch, 'out.tar.gz');
        const bytes = await createArchive(root, selection.files, archive);
        assert.ok(bytes > 0);

        const entries: string[] = [];
        await listTar({ file: archive, onReadEntry: (entry) => entries.push(entry.path) });
        assert.deepEqual(
            entries.map((entry) => entry.replace(/^\.\//, '')).sort(),
            selection.files.map((file) => file.path).sort(),
        );
    });

    it('names the archive from its content and options, deterministically', async () => {
        const selection = await collectFiles(root);
        const a = deployArchiveName(selection.files, { directory: '/', clean: false });
        const b = deployArchiveName(selection.files, { directory: '/', clean: false });
        const c = deployArchiveName(selection.files, { directory: '/', clean: true });
        assert.match(a, /^\.aclclouds-deploy-[0-9a-f]{16}\.tar\.gz$/);
        assert.equal(a, b);
        assert.notEqual(a, c);
    });

    it('derives rsync excludes from the same rules', async () => {
        const selection = await collectFiles(root);
        const rules = rsyncExcludes(selection, { clean: true, keep: ['world', '.env'] });
        assert.ok(rules.includes('/node_modules/'));
        assert.ok(rules.includes('/sub/local.txt'));
        assert.ok(rules.includes('/link.js'));
        assert.ok(rules.includes('/world'));
        assert.ok(!rules.includes('/dist/'));
    });
});
