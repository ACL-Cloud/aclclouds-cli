import type { FetchLike } from '../src/api/client.js';
import type { Service } from '../src/api/types.js';

export interface RecordedRequest {
    method: string;
    url: URL;
    headers: Headers;
    body: string | undefined;
    form?: FormData;
}

export type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export function noContent(): Response {
    return new Response(null, { status: 204 });
}

/**
 * Fake fetch routed by "METHOD pathname" (or "METHOD absolute-url-without-query").
 * A route may be a handler or a queue of handlers consumed in order (the last one repeats).
 */
export function mockFetch(routes: Record<string, Handler | Handler[]>) {
    const calls: RecordedRequest[] = [];
    const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));

    const fetchImpl: FetchLike = async (input, init = {}) => {
        const url = new URL(input);
        const method = (init.method ?? 'GET').toUpperCase();
        const headers = new Headers(init.headers);
        let body: string | undefined;
        let form: FormData | undefined;
        if (init.body instanceof FormData) {
            form = init.body;
        } else if (typeof init.body === 'string') {
            body = init.body;
        } else if (init.body instanceof Uint8Array) {
            body = Buffer.from(init.body).toString('utf8');
        }
        const request: RecordedRequest = { method, url, headers, body, form };
        calls.push(request);

        const queue = queues.get(`${method} ${url.pathname}`) ?? queues.get(`${method} ${url.origin}${url.pathname}`);
        if (!queue || queue.length === 0) {
            return json({ errors: [{ code: 'NotFound', detail: `No mock for ${method} ${url.pathname}` }] }, 404);
        }
        const handler = queue.length > 1 ? (queue.shift() as Handler) : (queue[0] as Handler);
        return handler(request);
    };

    return { fetch: fetchImpl, calls };
}

export function service(overrides: Partial<Service> = {}): Service {
    return {
        identifier: 'abcd1234',
        uuid: 'abcd1234-0000-4000-8000-000000000000',
        name: 'Survival',
        service_type: 'minecraft',
        status: null,
        ...overrides,
    };
}

export function serviceList(services: Service[], page = 1, totalPages = 1) {
    return {
        object: 'list',
        data: services.map((attributes) => ({ object: 'server', attributes })),
        meta: {
            pagination: {
                total: services.length,
                count: services.length,
                per_page: 100,
                current_page: page,
                total_pages: totalPages,
            },
        },
    };
}

export const noSleep = async (): Promise<void> => undefined;
