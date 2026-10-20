import type { ApiClient } from './api/client.js';
import type { Service } from './api/types.js';
import { servicePath } from './services.js';

export const MAX_LOG_LINES = 100;

export async function fetchLogs(client: ApiClient, service: Service, lines = MAX_LOG_LINES): Promise<string[]> {
    const count = Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(lines)));
    const response = await client.get<{ data?: unknown }>(servicePath(service, '/logs'), { lines: count });
    return Array.isArray(response?.data) ? response.data.map((line) => String(line)) : [];
}

/**
 * Lines of `next` that were not in `previous`, for two overlapping windows of
 * the same console (each poll returns the last N lines). Finds the longest
 * suffix of `previous` that is a prefix of `next`; without overlap (more than
 * N new lines, or the console was reset) every line of `next` is new.
 */
export function newLogLines(previous: readonly string[], next: readonly string[]): string[] {
    if (previous.length === 0) {
        return [...next];
    }

    for (let overlap = Math.min(previous.length, next.length); overlap > 0; overlap--) {
        const offset = previous.length - overlap;
        let matches = true;
        for (let index = 0; index < overlap; index++) {
            if (previous[offset + index] !== next[index]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return next.slice(overlap);
        }
    }

    return [...next];
}

/** Keeps a rolling window and returns only the new lines at each poll. */
export class LogFollower {
    private window: string[] = [];

    constructor(
        private readonly client: ApiClient,
        private readonly service: Service,
    ) {}

    /** Takes the current window as the starting point and returns it. */
    async prime(lines = MAX_LOG_LINES): Promise<string[]> {
        this.window = await fetchLogs(this.client, this.service, MAX_LOG_LINES);
        return this.window.slice(-lines);
    }

    async poll(): Promise<string[]> {
        const next = await fetchLogs(this.client, this.service, MAX_LOG_LINES);
        const fresh = newLogLines(this.window, next);
        this.window = next;
        return fresh;
    }
}
