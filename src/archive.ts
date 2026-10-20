import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { create as createTar } from 'tar';
import { CliError, ExitCode } from './errors.js';

/** Never deployed unless a `.aclignore` re-includes them with `!pattern`. */
export const DEFAULT_IGNORES = [
    '.git/',
    'node_modules/',
    '__pycache__/',
    '.venv/',
    '.DS_Store',
    '.aclclouds-deploy-*',
];

export interface FileEntry {
    /** Path relative to the deployed directory, with `/` separators. */
    path: string;
    size: number;
    mtimeMs: number;
}

export interface FileSelection {
    files: FileEntry[];
    /** Ignored paths, directories end with `/` (not descended into). */
    ignored: string[];
    /** Symbolic links are not deployed. */
    symlinks: string[];
    /** `.env` files that will be deployed (secrets). */
    envFiles: string[];
    totalBytes: number;
}

interface Matcher {
    /** Directory of the ignore file, relative to the root ('' = root). */
    base: string;
    rules: Ignore;
}

async function readIgnoreFile(path: string): Promise<string | null> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return null;
    }
}

async function matcherFor(dirAbs: string, base: string): Promise<Matcher | null> {
    const contents = [
        base === '' ? DEFAULT_IGNORES.join('\n') : null,
        await readIgnoreFile(join(dirAbs, '.gitignore')),
        // .aclignore comes last so it can re-include (`!dist/`) what git ignores.
        await readIgnoreFile(join(dirAbs, '.aclignore')),
    ].filter((value): value is string => value !== null);

    if (contents.length === 0) {
        return null;
    }
    return { base, rules: ignore().add(contents.join('\n')) };
}

/** Applies the ignore files from the root down to the entry's directory; the deepest rule wins. */
export function isIgnored(path: string, isDirectory: boolean, matchers: readonly Matcher[]): boolean {
    let ignored = false;
    for (const matcher of matchers) {
        const local = matcher.base === '' ? path : path.slice(matcher.base.length + 1);
        const result = matcher.rules.test(isDirectory ? `${local}/` : local);
        if (result.ignored) {
            ignored = true;
        } else if (result.unignored) {
            ignored = false;
        }
    }
    return ignored;
}

const ENV_FILE = /^\.env(\..+)?$/;

/**
 * Lists the files to deploy from `root`, honoring `.gitignore` and `.aclignore`
 * (at every level) and the default ignores. Sorted for reproducible archives.
 */
export async function collectFiles(root: string): Promise<FileSelection> {
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) {
        throw new CliError(`${root} is not a directory.`, ExitCode.USAGE);
    }

    const selection: FileSelection = { files: [], ignored: [], symlinks: [], envFiles: [], totalBytes: 0 };

    const walk = async (dirAbs: string, dirRel: string, parents: Matcher[]): Promise<void> => {
        const own = await matcherFor(dirAbs, dirRel);
        const matchers = own ? [...parents, own] : parents;
        const entries = (await readdir(dirAbs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));

        for (const entry of entries) {
            const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
            const abs = join(dirAbs, entry.name);
            const info = await lstat(abs);

            if (info.isSymbolicLink()) {
                if (!isIgnored(rel, false, matchers)) {
                    selection.symlinks.push(rel);
                }
                continue;
            }
            if (info.isDirectory()) {
                if (isIgnored(rel, true, matchers)) {
                    selection.ignored.push(`${rel}/`);
                } else {
                    await walk(abs, rel, matchers);
                }
                continue;
            }
            if (!info.isFile()) {
                continue;
            }
            if (isIgnored(rel, false, matchers)) {
                selection.ignored.push(rel);
                continue;
            }

            selection.files.push({ path: rel, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
            selection.totalBytes += info.size;
            if (ENV_FILE.test(entry.name)) {
                selection.envFiles.push(rel);
            }
        }
    };

    await walk(root, '', []);
    return selection;
}

/**
 * Archive name derived from the content and the deploy options, so retrying
 * the same deployment (after an approval) sends exactly the same request.
 */
export function deployArchiveName(files: readonly FileEntry[], options: unknown): string {
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(`${file.path}\0${file.size}\0${file.mtimeMs}\n`);
    }
    hash.update(JSON.stringify(options));
    return `.aclclouds-deploy-${hash.digest('hex').slice(0, 16)}.tar.gz`;
}

/** Writes a gzip tarball of the selected files. */
export async function createArchive(root: string, files: readonly FileEntry[], outFile: string): Promise<number> {
    if (files.length === 0) {
        throw new CliError('Nothing to deploy: every file is ignored.', ExitCode.USAGE, 'Check .gitignore and .aclignore.');
    }
    await createTar(
        { gzip: true, file: outFile, cwd: root, portable: true, noDirRecurse: true },
        // node-tar reads a leading `@` as "append this archive": keep such names literal.
        files.map((file) => (file.path.startsWith('@') ? `./${file.path}` : file.path)),
    );
    return (await stat(outFile)).size;
}
