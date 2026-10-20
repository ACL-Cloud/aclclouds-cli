/**
 * Unwraps the Fractal envelopes of the client API:
 * item `{object, attributes}`, list `{object: 'list', data: [...], meta: {pagination}}`.
 */

export interface Pagination {
    total: number;
    count: number;
    per_page: number;
    current_page: number;
    total_pages: number;
}

export interface ListPage<T> {
    items: T[];
    pagination?: Pagination;
    meta?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function unwrapItem<T>(payload: unknown): T {
    if (isRecord(payload) && isRecord(payload.attributes)) {
        return payload.attributes as T;
    }
    return payload as T;
}

export function unwrapList<T>(payload: unknown): ListPage<T> {
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
        return { items: Array.isArray(payload) ? (payload as T[]) : [] };
    }

    const items = payload.data.map((entry) => unwrapItem<T>(entry));
    const meta = isRecord(payload.meta) ? payload.meta : undefined;
    const pagination = meta && isRecord(meta.pagination) ? (meta.pagination as unknown as Pagination) : undefined;
    return { items, pagination, meta };
}
