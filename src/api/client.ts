import { ApiError, type ApprovalInfo } from '../errors.js';
import { USER_AGENT } from '../version.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | undefined;

export interface RequestSpec {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Path below the panel URL, e.g. `/api/client/servers/abc/power`. */
    path: string;
    query?: Record<string, QueryValue>;
    /** JSON body. */
    json?: unknown;
    /** Raw body (file contents). */
    body?: string | Uint8Array;
    contentType?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    /** Return the body as text, never parsed (file contents). */
    raw?: boolean;
}

/**
 * Called when the panel answers 428 approval_required. Resolves with the
 * approval id once approved (the request is then repeated), or throws.
 */
export type ApprovalHandler = (approval: ApprovalInfo, client: ApiClient) => Promise<string>;

export interface ApiClientOptions {
    panelUrl: string;
    token: string;
    fetch?: FetchLike;
    approvalHandler?: ApprovalHandler;
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Typed client of the panel API (`/api/client/*`), with the approval retry built in. */
export class ApiClient {
    readonly panelUrl: string;
    readonly fetch: FetchLike;
    private readonly token: string;
    private readonly approvalHandler?: ApprovalHandler;
    private readonly timeoutMs: number;

    constructor(options: ApiClientOptions) {
        this.panelUrl = options.panelUrl.replace(/\/+$/, '');
        this.token = options.token;
        this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
        this.approvalHandler = options.approvalHandler;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /** Same client without the interactive approval handler (approvals surface as ApiError 428). */
    withoutApprovalHandler(): ApiClient {
        return new ApiClient({ panelUrl: this.panelUrl, token: this.token, fetch: this.fetch, timeoutMs: this.timeoutMs });
    }

    get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
        return this.request<T>({ method: 'GET', path, query });
    }

    post<T>(path: string, json?: unknown): Promise<T> {
        return this.request<T>({ method: 'POST', path, json });
    }

    /**
     * Sends a request. When the panel asks for an approval and a handler is set,
     * waits for it, then repeats exactly the same request with `X-Agent-Approval`.
     */
    async request<T>(spec: RequestSpec): Promise<T> {
        let approvalId: string | undefined;
        for (let attempt = 0; ; attempt++) {
            try {
                const headers = approvalId ? { ...spec.headers, 'X-Agent-Approval': approvalId } : spec.headers;
                return await this.send<T>({ ...spec, headers });
            } catch (error) {
                if (error instanceof ApiError && error.isApprovalRequired && this.approvalHandler && attempt < 2) {
                    approvalId = await this.approvalHandler(error.approval as ApprovalInfo, this);
                    continue;
                }
                throw error;
            }
        }
    }

    private async send<T>(spec: RequestSpec): Promise<T> {
        const endpoint = `${spec.method} ${spec.path}`;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
            'User-Agent': USER_AGENT,
            ...spec.headers,
        };

        let body: string | Uint8Array | undefined;
        if (spec.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(spec.json);
        } else if (spec.body !== undefined) {
            headers['Content-Type'] = spec.contentType ?? 'text/plain';
            body = spec.body;
        }

        let response: Response;
        try {
            response = await this.fetch(this.url(spec.path, spec.query), {
                method: spec.method,
                headers,
                body,
                signal: AbortSignal.timeout(spec.timeoutMs ?? this.timeoutMs),
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new ApiError(`Could not reach ${this.panelUrl}: ${reason}`, 0, 'network_error', endpoint, undefined);
        }

        if (spec.raw && response.ok) {
            return (await response.text()) as T;
        }
        const data = await readBody(response);
        if (!response.ok) {
            throw toApiError(response.status, endpoint, data);
        }
        return data as T;
    }

    url(path: string, query?: Record<string, QueryValue>): string {
        const url = new URL(this.panelUrl + path);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    }
}

/** Parses a JSON body when there is one, otherwise returns the text (or undefined when empty). */
export async function readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === '') {
        return undefined;
    }
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('json') || /^\s*[[{]/.test(text)) {
        try {
            return JSON.parse(text) as unknown;
        } catch {
            return text;
        }
    }
    return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Builds an ApiError from the panel's error formats (fractal `errors[]`, `{error}`, `{message}`). */
export function toApiError(status: number, endpoint: string, data: unknown): ApiError {
    let code: string | undefined;
    let message: string | undefined;
    let approval: ApprovalInfo | undefined;
    let requiredScope: string | undefined;

    if (isRecord(data)) {
        const first = Array.isArray(data.errors) && isRecord(data.errors[0]) ? data.errors[0] : undefined;
        if (first) {
            code = typeof first.code === 'string' ? first.code : undefined;
            const details = (data.errors as unknown[])
                .filter(isRecord)
                .map((entry) => (typeof entry.detail === 'string' ? entry.detail : ''))
                .filter(Boolean);
            message = details.join(' ') || undefined;
        } else if (typeof data.error === 'string') {
            code = data.error;
            message = typeof data.error_description === 'string' ? data.error_description : data.error;
        } else if (typeof data.message === 'string') {
            message = data.message;
        }
        if (isRecord(data.approval)) {
            approval = data.approval as unknown as ApprovalInfo;
        }
        if (typeof data.required_scope === 'string') {
            requiredScope = data.required_scope;
        }
    } else if (typeof data === 'string' && data.length > 0 && data.length < 300 && !data.includes('<')) {
        message = data;
    }

    return new ApiError(message ?? `The panel answered ${status} for ${endpoint}.`, status, code, endpoint, data, approval, requiredScope);
}
