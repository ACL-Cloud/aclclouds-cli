import { ApiClient } from './api/client.js';
import { interactiveApprovalHandler } from './approvals.js';
import { type Session, loadSession } from './config.js';
import { CliError, ExitCode } from './errors.js';

export interface ClientOptions {
    /** Wait for approvals interactively (CLI). Off for the MCP server. */
    interactiveApprovals?: boolean;
}

export function clientFromSession(session: Session, options: ClientOptions = {}): ApiClient {
    if (!session.token) {
        throw new CliError(
            `You are not signed in to ${session.panelUrl}.`,
            ExitCode.AUTH,
            'Run `npx aclclouds login`, or set ACLCLOUDS_TOKEN.',
        );
    }
    return new ApiClient({
        panelUrl: session.panelUrl,
        token: session.token,
        approvalHandler: options.interactiveApprovals === false ? undefined : interactiveApprovalHandler,
    });
}

/** Client for CLI commands: signed in, with the interactive approval flow. */
export async function requireClient(options: ClientOptions = {}): Promise<ApiClient> {
    return clientFromSession(await loadSession(), options);
}
