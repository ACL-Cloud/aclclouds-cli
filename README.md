# aclclouds

The official command line tool for [ACLClouds](https://aclclouds.com): manage, deploy and debug your
game servers, Discord bots and VPS from a terminal, a CI job, or an AI assistant (MCP).

```bash
npx aclclouds login
npx aclclouds services
npx aclclouds deploy ./my-bot --service "Music Bot"
```

Nothing to install: `npx` downloads the latest version. Node.js 18 or newer is required.
For frequent use, `npm install -g aclclouds` gives you the `aclclouds` command.

## Sign in

```bash
aclclouds login
```

The CLI prints a short code and opens the panel. Check that the code matches, choose which
permissions and services this computer gets, and approve. The token is stored in
`~/.config/aclclouds/config.json` (`$XDG_CONFIG_HOME` is respected, `%APPDATA%\aclclouds` on Windows),
readable by you only (mode 0600). It is never printed.

| Option | |
|---|---|
| `--preset read\|operate\|deploy\|full` | Permissions requested (default `deploy`). `full` adds VPS shell, settings, billing (read) and domains. |
| `--token [key]` | Store an API key created in the panel (Account > API keys) instead. Without a value the key is prompted (hidden), or read from stdin: `echo "$KEY" \| aclclouds login --token`. |
| `--url <url>` | Another panel (default `https://aclclouds.com`). HTTPS is required. |
| `--no-browser` | Do not open the browser. |

```bash
aclclouds whoami          # account, panel, permissions
aclclouds logout          # revokes the CLI token and removes it from this computer
```

**CI and scripts:** set `ACLCLOUDS_TOKEN` (an API key from the panel, ideally limited to the
services and permissions the job needs). `ACLCLOUDS_URL` overrides the panel URL. The environment
always wins over the stored login.

## Services

A service is designated by its short identifier (`abcd1234`), its uuid, or its name
(case-insensitive, a unique part of the name is enough). When several services match, the
candidates are listed.

```bash
aclclouds services                 # alias: aclclouds ls
aclclouds services --type bot      # game, bot, vps, or a game such as minecraft
aclclouds status survival          # details + live state, CPU, memory, disk, uptime
```

## Power

```bash
aclclouds start survival
aclclouds restart "music bot" --wait          # waits until running (default timeout 120 s)
aclclouds stop my-vps --wait --timeout 60
aclclouds kill survival                        # force stop
```

Works for game servers, bots and VPS.

## Logs and commands

```bash
aclclouds logs survival             # last 100 lines (-n 1..100)
aclclouds logs survival -f          # follow (Ctrl+C to stop)

aclclouds exec survival -- say Server restarts in 5 minutes
aclclouds exec my-vps -- systemctl status nginx
aclclouds exec my-vps --cwd /var/www -- git pull
```

On a game server or bot, `exec` sends a console command and prints the console output of the next
seconds (`--wait 3`). On a VPS it runs a shell command through the guest agent (15 s maximum),
prints stdout/stderr and exits with the command's exit code. Console logs are not available on a
VPS: use `exec`, e.g. `aclclouds exec my-vps -- journalctl -n 100 --no-pager`.

## Files (game servers and bots)

```bash
aclclouds files ls survival /plugins
aclclouds files cat survival /server.properties
aclclouds files put survival ./MyPlugin.jar /plugins/       # into a directory
aclclouds files put survival ./config.yml /plugins/Foo/config.yml
aclclouds files get survival /logs/latest.log ./latest.log
aclclouds files mkdir survival /backups/manual
aclclouds files mv survival /old-world /archive/
aclclouds files rm survival /plugins/Old.jar /plugins/Old   # may need your approval in the panel
```

## Deploy a directory

```bash
aclclouds deploy ./my-bot --service "music bot"
aclclouds deploy . -s survival --path /plugins/MyPlugin --no-restart
aclclouds deploy ./site -s my-vps --path /var/www/site --run "systemctl reload nginx"
```

**Game servers and bots:**

1. The files are selected: `.gitignore` files (at every level) and `.aclignore` are respected;
   `.git`, `node_modules`, `__pycache__`, `.venv` and `.DS_Store` are always skipped.
   `.env` files **are** deployed (a notice is printed): add `.env` to `.aclignore` to keep it local.
   `.aclignore` uses the `.gitignore` syntax and can re-include what git ignores (`!dist/`).
2. A backup is created first. If the backup limit of the offer is reached, the CLI explains and asks;
   `--yes` deploys anyway, `--no-backup` skips it.
3. The archive is uploaded into the target directory and extracted there by the panel.
4. The service is restarted (unless `--no-restart`), the console is shown for 20 s (`--follow`),
   and the CLI reports whether it is running (exit code 1 if not).

| Option | |
|---|---|
| `-s, --service <service>` | Target service (required). |
| `--path <dir>` | Target directory (default `/`; required for a VPS). |
| `--clean` | Remove what the directory contains first (except `.trash` and `--keep`). Needs your approval in the panel. |
| `--keep a,b` | Names kept by `--clean`, e.g. `world,.env,data`. |
| `--no-backup`, `--no-restart` | Skip these steps. |
| `-y, --yes` | No confirmation, deploy even when no backup can be made. |
| `--dry-run` | List the files that would be sent, send nothing. |

**VPS:** the same file selection is synchronized with `rsync` over `ssh` to
`<username>@<ipv4>:<path>` (your SSH key must be on the VPS; `--ssh-key <file>` to choose it).
`--clean` adds `--delete` (ignored files such as `node_modules` are never deleted on the VPS).
`--run "<command>"` runs a command in the target directory afterwards. `ssh` and `rsync` must be
installed (on Windows, use WSL).

## Backups (game servers and bots)

```bash
aclclouds backups ls survival
aclclouds backups create survival --name "before update" --wait
aclclouds backups restore survival 3f2a --truncate     # id, id prefix or name; may need approval
```

## Approvals

Destructive actions (deleting files, restoring a backup, a clean deployment...) can require the
approval of the account holder, depending on the token settings. The CLI then prints what is
requested and a link to the panel (opened in your browser), waits until you approve or deny it,
and runs the action once approved. The approval covers only this exact request.

## Use with AI assistants (MCP)

`aclclouds mcp` runs a local [Model Context Protocol](https://modelcontextprotocol.io) server over
stdio. It exposes the ACLClouds tools (list services, power, logs, console, files, backups...,
served by the panel with your token's permissions) plus three local tools that work on your disk:

- `deploy_directory` (`service`, `path`, `directory?`, `clean?`, `keep?`, `restart?`): deploys a local
  folder like `aclclouds deploy` (without automatic backup; VPS over SSH without prompts);
- `upload_file` (`service`, `local_path`, `directory?`);
- `download_file` (`service`, `path`, `local_path`).

Sign in once with `npx aclclouds login`, then add the server to your assistant.

**Claude Code**

```bash
claude mcp add aclclouds -- npx -y aclclouds mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "aclclouds": {
      "command": "npx",
      "args": ["-y", "aclclouds", "mcp"]
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "aclclouds": {
      "command": "npx",
      "args": ["-y", "aclclouds", "mcp"]
    }
  }
}
```

To use a dedicated key instead of your login, add `"env": { "ACLCLOUDS_TOKEN": "..." }`.
When an action needs your approval, the assistant receives the link, shows it to you, and calls the
tool again once you have approved. Without the local tools, claude.ai and other remote clients can
connect directly to `https://aclclouds.com/mcp` (OAuth).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (API, network, failed deployment, service not running after a deployment) |
| 2 | Invalid usage |
| 3 | Not signed in, or token rejected: run `aclclouds login` |
| 4 | Service or backup not found, or ambiguous |
| 5 | Approval denied or expired |
| 6 | Permission missing for this token, or action reserved to the panel |
| 7 | Timeout (`--wait`, VPS command still running) |

`aclclouds exec` on a VPS exits with the exit code of the remote command.

## Security

- Tokens created by `aclclouds login` are agent tokens: limited to the permissions and services you
  chose, and they can never delete a service, pay, change your password, email, 2FA or API keys.
- Keep the default approval mode so that destructive actions wait for your approval in the panel.
- See and revoke every token in the panel: **Account > AI & automation** (or `aclclouds logout` for
  this computer). Every action is recorded in the activity log.
- The token is only sent to the panel it was created for, over HTTPS. Signed file transfer URLs
  never carry it.
- The local MCP tools can read and write files your user can access: approve their calls in your
  assistant as you would for any local tool.

## Development

```bash
npm ci
npm run build    # TypeScript (strict) to dist/
npm test         # node:test, no network
node dist/index.js --help
```

Set `ACLCLOUDS_DEBUG=1` to print stack traces.

## License

MIT

## Development

The source is TypeScript in `src/`. The published file is a single minified bundle built with Bun, with every dependency included.

```bash
bun install
bun run typecheck   # TypeScript, strict
bun test            # unit tests
bun run build       # writes dist/index.js (bundle)
```

Releases: bump `version` in `package.json`, commit, then push a tag `v<version>` that matches it. The GitHub workflow publishes to npm with the `NPM_TOKEN` secret.
