import { createInterface } from 'node:readline';
import pc from 'picocolors';

function colorsEnabled(stream: NodeJS.WriteStream): boolean {
    if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
        return true;
    }
    return Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

/** Colors for data printed on stdout, and for messages printed on stderr (only on a TTY). */
export const out = pc.createColors(colorsEnabled(process.stdout));
export const err = pc.createColors(colorsEnabled(process.stderr));

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stderr.isTTY);

/** Data goes to stdout, everything else (progress, notices, errors) to stderr. */
export function print(line = ''): void {
    process.stdout.write(`${line}\n`);
}

export function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function info(message: string): void {
    process.stderr.write(`${message}\n`);
}

export function success(message: string): void {
    process.stderr.write(`${err.green('✔')} ${message}\n`);
}

export function warn(message: string): void {
    process.stderr.write(`${err.yellow('!')} ${message}\n`);
}

export function step(message: string): void {
    process.stderr.write(`${err.cyan('›')} ${message}\n`);
}

const ANSI = /\u001b\[[0-9;]*m/g;

function visibleLength(value: string): number {
    return value.replace(ANSI, '').length;
}

/** Plain-text table: header row then aligned columns. */
export function table(headers: string[], rows: string[][]): string {
    const widths = headers.map((header, index) =>
        Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[index] ?? ''))),
    );
    const line = (cells: string[]) =>
        cells
            .map((cell, index) =>
                index === cells.length - 1 ? cell : cell + ' '.repeat((widths[index] ?? 0) - visibleLength(cell)),
            )
            .join('  ')
            .trimEnd();
    return [out.bold(line(headers)), ...rows.map(line)].join('\n');
}

export function formatBytes(bytes: number | undefined | null): string {
    if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) {
        return '-';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds: number | undefined | null): string {
    if (!seconds || seconds < 0) {
        return '-';
    }
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

export function colorState(state: string): string {
    switch (state) {
        case 'running':
            return out.green(state);
        case 'offline':
        case 'stopped':
            return out.red(state);
        case 'starting':
        case 'stopping':
            return out.yellow(state);
        default:
            return state;
    }
}

/** Spinner on stderr (only on a TTY; otherwise prints the text once). */
export class Spinner {
    private timer: NodeJS.Timeout | undefined;
    private frame = 0;
    private text = '';

    start(text: string): this {
        this.text = text;
        if (!process.stderr.isTTY) {
            info(text);
            return this;
        }
        const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.timer = setInterval(() => {
            this.frame = (this.frame + 1) % frames.length;
            process.stderr.write(`\r${err.cyan(frames[this.frame] ?? '')} ${this.text}\u001b[K`);
        }, 100);
        this.timer.unref();
        return this;
    }

    update(text: string): void {
        this.text = text;
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
            process.stderr.write('\r\u001b[K');
        }
    }
}

/** Asks a question on stderr and returns the answer. */
export async function ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        return await new Promise<string>((resolve) => rl.question(question, resolve));
    } finally {
        rl.close();
    }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
    const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (answer === '') {
        return defaultYes;
    }
    return ['y', 'yes', 'o', 'oui'].includes(answer);
}

/** Reads a secret without echoing it. */
export async function askSecret(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    process.stderr.write(question);
    (rl as unknown as { _writeToOutput: (value: string) => void })._writeToOutput = () => undefined;
    try {
        return (await new Promise<string>((resolve) => rl.question('', resolve))).trim();
    } finally {
        rl.close();
        process.stderr.write('\n');
    }
}

/** Reads the whole standard input (piped token, file contents). */
export async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString('utf8');
}
