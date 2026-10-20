import { Command, CommanderError } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { suggestCommand } from './suggest.js';
import { registerBackupCommands } from './commands/backups.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerExecCommand } from './commands/exec.js';
import { registerFileCommands } from './commands/files.js';
import { registerLogCommands } from './commands/logs.js';
import { registerPowerCommands } from './commands/power.js';
import { registerServiceCommands } from './commands/services.js';
import { ExitCode, describeError } from './errors.js';
import { runMcpServer } from './mcp/server.js';
import { err } from './output.js';
import { VERSION } from './version.js';

export function buildProgram(): Command {
    const program = new Command();
    program
        .name('aclclouds')
        .description('Manage, deploy and debug your ACLClouds game servers, Discord bots and VPS.')
        .version(VERSION, '-v, --version')
        .showHelpAfterError('(run `aclclouds help` to see the available commands)')
        .exitOverride();

    // Unknown word after `aclclouds`: say how to get help, and suggest the closest command.
    program.on('command:*', (operands: string[]) => {
        const typed = operands[0] ?? '';
        const known = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);
        const suggestion = suggestCommand(typed, known);
        process.stderr.write(
            `error: unknown command '${typed}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}\n` +
                'Run `aclclouds help` to see the available commands.\n',
        );
        process.exit(2);
    });

    registerAuthCommands(program);
    registerServiceCommands(program);
    registerPowerCommands(program);
    registerLogCommands(program);
    registerExecCommand(program);
    registerFileCommands(program);
    registerDeployCommand(program);
    registerBackupCommands(program);

    program
        .command('mcp')
        .description('Run the local MCP server on stdio (for Claude Code, Claude Desktop, Cursor…)')
        .action(() => runMcpServer());

    program.addHelpText(
        'after',
        `
Examples:
  npx aclclouds login
  aclclouds services
  aclclouds logs my-bot -f
  aclclouds deploy ./bot --service my-bot
  aclclouds exec my-vps -- systemctl status nginx

Environment: ACLCLOUDS_TOKEN, ACLCLOUDS_URL (default https://aclclouds.com).`,
    );

    return program;
}

/** Runs the CLI and sets the exit code; errors are printed on stderr with the next step. */
export async function run(argv: string[]): Promise<void> {
    const program = buildProgram();
    try {
        await program.parseAsync(argv);
    } catch (error) {
        if (error instanceof CommanderError) {
            // Help and version exit with 0; usage errors were already printed by commander.
            process.exitCode = error.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
            return;
        }
        const described = describeError(error);
        process.stderr.write(`${err.red('✖')} ${described.message}\n`);
        if (described.hint) {
            process.stderr.write(`  ${err.dim(described.hint)}\n`);
        }
        if (process.env.ACLCLOUDS_DEBUG && error instanceof Error && error.stack) {
            process.stderr.write(`${err.dim(error.stack)}\n`);
        }
        process.exitCode = described.exitCode;
    }
}
