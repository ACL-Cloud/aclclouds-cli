import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reads the version from the package.json shipped next to `dist/`. */
function readVersion(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
        try {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
            if (pkg.name === 'aclclouds' && typeof pkg.version === 'string') {
                return pkg.version;
            }
        } catch {
            // Try the next location.
        }
    }
    return '0.0.0';
}

export const VERSION = readVersion();

export const USER_AGENT = `aclclouds-cli/${VERSION} (node ${process.version}; ${process.platform})`;
