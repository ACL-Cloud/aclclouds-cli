/** Process exit codes, documented in the README. */
export const ExitCode = {
    OK: 0,
    ERROR: 1,
    USAGE: 2,
    AUTH: 3,
    NOT_FOUND: 4,
    APPROVAL: 5,
    FORBIDDEN: 6,
    TIMEOUT: 7,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** An error meant for the user: a clear message, an optional next step, an exit code. */
export class CliError extends Error {
    constructor(
        message: string,
        public readonly exitCode: ExitCodeValue = ExitCode.ERROR,
        public readonly hint?: string,
    ) {
        super(message);
        this.name = 'CliError';
    }
}

/** Approval of a destructive action, as returned by the panel. */
export interface ApprovalInfo {
    id: string;
    status: string;
    action: string;
    summary: string;
    details: unknown[];
    approve_url: string;
    expires_at: string;
    agent_name?: string | null;
    server?: { identifier: string; name: string } | null;
}

/** A non-2xx answer from the panel API. */
export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly code: string | undefined,
        public readonly endpoint: string,
        public readonly body: unknown,
        public readonly approval?: ApprovalInfo,
        public readonly requiredScope?: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }

    get isApprovalRequired(): boolean {
        return this.status === 428 && this.approval !== undefined;
    }
}

export interface DescribedError {
    message: string;
    hint?: string;
    exitCode: ExitCodeValue;
}

/** Turns any error into a message, a next step and an exit code (never includes the token). */
export function describeError(error: unknown): DescribedError {
    if (error instanceof CliError) {
        return { message: error.message, hint: error.hint, exitCode: error.exitCode };
    }

    if (error instanceof ApiError) {
        switch (true) {
            case error.status === 401:
                return {
                    message: 'The panel rejected the token (expired or revoked).',
                    hint: 'Run `aclclouds login` to sign in again.',
                    exitCode: ExitCode.AUTH,
                };
            case error.code === 'insufficient_scope':
                return {
                    message: `This token does not have the "${error.requiredScope ?? 'required'}" permission.`,
                    hint: 'Grant it in the panel (Account > AI & automation), or run `aclclouds login --preset full`.',
                    exitCode: ExitCode.FORBIDDEN,
                };
            case error.code === 'agent_forbidden':
                return {
                    message: 'This action is only available from the ACLClouds panel, not to the CLI or AI agents.',
                    hint: 'Sign in to the panel in your browser to do it yourself.',
                    exitCode: ExitCode.FORBIDDEN,
                };
            case error.code === 'approval_denied':
                return { message: 'The account holder denied this action.', exitCode: ExitCode.APPROVAL };
            case error.isApprovalRequired:
                return {
                    message: `Approval required: ${error.approval?.summary ?? 'destructive action'}.`,
                    hint: `Approve it at ${error.approval?.approve_url}, then run the same command again.`,
                    exitCode: ExitCode.APPROVAL,
                };
            case error.code === 'service_not_allowed' || error.status === 404:
                return {
                    message: error.message,
                    hint: 'Check the name with `aclclouds services`; the token may be limited to some services.',
                    exitCode: ExitCode.NOT_FOUND,
                };
            case error.status === 403:
                return { message: error.message, exitCode: ExitCode.FORBIDDEN };
            case error.status === 429:
                return {
                    message: 'Too many requests: the panel is rate limiting this token.',
                    hint: 'Wait a minute and try again.',
                    exitCode: ExitCode.ERROR,
                };
            case error.status === 0:
                return { message: error.message, hint: 'Check your connection or ACLCLOUDS_URL.', exitCode: ExitCode.ERROR };
            default:
                return { message: error.message, exitCode: ExitCode.ERROR };
        }
    }

    if (error instanceof Error) {
        return { message: error.message, exitCode: ExitCode.ERROR };
    }

    return { message: String(error), exitCode: ExitCode.ERROR };
}
