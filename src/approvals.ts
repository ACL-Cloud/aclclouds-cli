import type { ApiClient, ApprovalHandler } from './api/client.js';
import { openBrowser } from './browser.js';
import { type ApprovalInfo, CliError, ExitCode } from './errors.js';
import { Spinner, err, info } from './output.js';

export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitForApprovalOptions {
    intervalMs?: number;
    sleep?: Sleep;
    now?: () => number;
    onStatus?: (status: string) => void;
}

/**
 * Polls `GET /api/client/agent/approvals/{id}` until the account holder decides.
 * Resolves with the approval id when approved, throws when denied or expired.
 */
export async function waitForApproval(
    client: ApiClient,
    approval: ApprovalInfo,
    options: WaitForApprovalOptions = {},
): Promise<string> {
    const wait = options.sleep ?? sleep;
    const now = options.now ?? Date.now;
    const intervalMs = options.intervalMs ?? 3000;
    const expiresAt = Date.parse(approval.expires_at);
    // Grace period: the panel is the judge of expiry, our clock may drift.
    const deadline = Number.isFinite(expiresAt) ? expiresAt + 60_000 : now() + 16 * 60_000;

    while (now() < deadline) {
        await wait(intervalMs);
        const response = await client.get<{ data: ApprovalInfo }>(
            `/api/client/agent/approvals/${encodeURIComponent(approval.id)}`,
        );
        const status = response.data?.status;
        options.onStatus?.(status);

        if (status === 'approved' || status === 'executed') {
            return approval.id;
        }
        if (status === 'denied') {
            throw new CliError('The account holder denied this action.', ExitCode.APPROVAL);
        }
        if (status === 'expired') {
            throw new CliError(
                'The approval request expired before a decision was made.',
                ExitCode.APPROVAL,
                'Run the same command again to create a new request.',
            );
        }
    }

    throw new CliError('The approval request expired before a decision was made.', ExitCode.APPROVAL);
}

function detailLines(details: unknown[]): string[] {
    return details
        .map((detail) => (typeof detail === 'string' ? detail : JSON.stringify(detail)))
        .slice(0, 20);
}

/** Interactive handler for the CLI: explains, opens the browser, waits with a spinner. */
export const interactiveApprovalHandler: ApprovalHandler = async (approval, client) => {
    info('');
    info(`${err.yellow(err.bold('Approval required:'))} ${approval.summary || approval.action}`);
    for (const line of detailLines(approval.details ?? [])) {
        info(`  ${err.dim('•')} ${line}`);
    }
    info(`Approve or deny it in the panel: ${err.underline(approval.approve_url)}`);
    if (process.stderr.isTTY && openBrowser(approval.approve_url)) {
        info(err.dim('(opened in your browser)'));
    }

    const spinner = new Spinner().start('Waiting for your decision in the panel… (Ctrl+C to cancel)');
    try {
        const id = await waitForApproval(client, approval);
        spinner.stop();
        info(`${err.green('✔')} Approved, running the action.`);
        return id;
    } finally {
        spinner.stop();
    }
};
