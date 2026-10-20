import { spawn } from 'node:child_process';

/** Opens a URL in the default browser. Best effort: returns false when it cannot. */
export function openBrowser(url: string): boolean {
    if (process.env.ACLCLOUDS_NO_BROWSER || process.env.CI || !/^https?:\/\//.test(url)) {
        return false;
    }

    const [command, args] =
        process.platform === 'darwin'
            ? ['open', [url]]
            : process.platform === 'win32'
              ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
              : ['xdg-open', [url]];

    try {
        const child = spawn(command, args as string[], { detached: true, stdio: 'ignore' });
        child.on('error', () => undefined);
        child.unref();
        return true;
    } catch {
        return false;
    }
}
