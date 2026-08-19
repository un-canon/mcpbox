# MCPBox

Isolated Docker workbench with MCP and SSH access for coding agents.

MCPBox runs two containers that share one persistent workspace:

* **mcp** — a Node.js MCP server (Streamable HTTP) exposing four tools to
  Claude Code, Codex or any MCP client: `exec_command`, `write_stdin`,
  `apply_patch`, `view_image`.
* **workbench** — an OpenSSH server so *you* can log into the same
  `/workspace` with your SSH key.

Everything the agent does happens inside the container. Nothing from your host
(home directory, SSH agent, cloud credentials, Docker socket) is mounted by
default.

> **Read this first.** `exec_command` is an unrestricted shell with
> passwordless `sudo` inside the container. MCPBox is a *container-boundary,
> single-user, trust-the-client* remote-execution environment — not a
> fine-grained tool-permission system and not a multi-tenant sandbox. See
> [docs/security-model.md](docs/security-model.md).

## Requirements

* Docker Engine 24+ or Docker Desktop, with Compose v2
* `ssh`, `ssh-keygen`, `curl`, `openssl` on the host
* an SSH public key (`ssh-keygen -t ed25519` if you have none)

Works on Linux, macOS (Docker Desktop) and Windows via WSL2 (run the commands
inside your WSL distribution).

## Quick start

```bash
git clone https://github.com/un-canon/mcpbox.git
cd mcpbox
./setup.sh ~/.ssh/id_ed25519.pub
```

`setup.sh` validates the key, generates a bearer token in
`runtime/mcpbox-token` (0600, git-ignored), creates `.env` from
`.env.example`, builds both images, starts the stack and waits for the health
endpoint. It ends with something like:

```text
Ready.

MCP endpoint (Streamable HTTP, bearer auth):
  http://127.0.0.1:33333/mcp
Bearer token file (keep private, 0600):
  /path/to/mcpbox/runtime/mcpbox-token

Claude Code:
  claude mcp add --transport http --scope user mcpbox http://127.0.0.1:33333/mcp \
    --header "Authorization: Bearer $(cat /path/to/mcpbox/runtime/mcpbox-token)"

SSH:
  ssh -p 22222 agent@127.0.0.1
```

### Connect Claude Code

```bash
claude mcp add --transport http --scope user mcpbox http://127.0.0.1:33333/mcp \
  --header "Authorization: Bearer $(cat runtime/mcpbox-token)"
claude mcp get mcpbox
```

### Connect Codex

Codex configures HTTP servers in `~/.codex/config.toml` and reads the token
from an environment variable:

```toml
[mcp_servers.mcpbox]
url = "http://127.0.0.1:33333/mcp"
bearer_token_env_var = "MCPBOX_TOKEN"
```

```bash
export MCPBOX_TOKEN="$(cat runtime/mcpbox-token)"
codex mcp list
```

Ready-to-copy snippets for both clients are in [config/](config/).

### SSH into the same workspace

```bash
ssh -p 22222 agent@127.0.0.1
cd ~/project          # symlink to /workspace/project
```

Only the key you passed to `setup.sh` is accepted. Password, root, agent
forwarding, X11 and remote gateway ports are disabled.

## What is shared between MCP and SSH — and what is not

The two containers share **only** the `/workspace` volume. They do **not**
share processes, `/tmp`, the root filesystem, packages installed with `apt`,
or system configuration. `sudo apt install foo` through the agent does not
make `foo` appear in your SSH session, and a server you start over SSH is not
visible to `exec_command`'s `ps`. Details and the reasoning:
[docs/architecture.md](docs/architecture.md).

## Remote machine

Run MCPBox on a remote Linux box and reach it only through SSH:

1. On the remote host, in `.env`: `MCPBOX_SSH_BIND=0.0.0.0`, then
   `docker compose up -d`. Firewall port 22222 to your IPs. Port 33333 stays
   loopback-only — do **not** publish it.
2. On your laptop, keep a tunnel open:
   ```bash
   ssh -N -L 33333:mcp:3000 -p 22222 agent@REMOTE_HOST
   ```
   (`mcp` is the Compose service name, resolved inside the workbench.)
3. Use the same local URL `http://127.0.0.1:33333/mcp` with the same bearer
   token (copy `runtime/mcpbox-token` over a secure channel).

A VPN or an authenticating reverse proxy that you operate are the other
acceptable ways to reach the MCP port. Exposing it directly to the internet is
not.

## Operations

| Task | Command |
| --- | --- |
| Status / logs | `docker compose ps` · `docker compose logs --tail=100 mcp workbench` |
| Rebuild after upgrading | `git pull && docker compose up -d --build` |
| Stop (keep workspace) | `docker compose down` |
| Delete everything incl. workspace + host key | `docker compose down --volumes` |
| Rotate token | `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '=' > runtime/mcpbox-token && docker compose restart mcp` |
| Change SSH keys | edit `runtime/authorized_keys`, `docker compose restart workbench` |
| Tune limits | edit `.env` (see [docs/configuration.md](docs/configuration.md)), `docker compose up -d` |

## Limits and defaults

Per container: 2 CPUs, 4 GiB RAM, 1024/2048 PIDs, 65536 open files. Server:
16 concurrent sessions, 1 h max runtime, 30 min idle timeout, 2 M chars of
buffered output per session, 12 MiB images. All overridable in `.env`.
Not enforced by default: disk quota on the workspace, network egress
filtering — see the security model.

## Migrating from `ssh-mcp-four-tools-kit`

* The token now goes in `Authorization: Bearer …` at `/mcp` instead of the URL
  path. `setup.sh` renames `runtime/mcp-path-token` to `runtime/mcpbox-token`.
* If a client cannot send headers yet, set `MCPBOX_LEGACY_PATH_TOKEN=1` to
  also accept `http://127.0.0.1:33333/<token>/mcp` (deprecated; logs a
  warning).
* `.env` variable names changed (`SSH_PORT` → `MCPBOX_SSH_PORT`, …); see
  `.env.example`.
* `view_image` no longer has a `detail` parameter (it never did anything).

## Documentation

* [docs/security-model.md](docs/security-model.md) — trust boundary, what
  MCPBox is and is not for
* [docs/architecture.md](docs/architecture.md) — containers, volumes, process
  model
* [docs/configuration.md](docs/configuration.md) — every `.env` variable
* [docs/adr/](docs/adr/) — design decisions (auth, protocol/SDK, token
  handoff, limits, process lifecycle, licence)
* [SECURITY.md](SECURITY.md) — reporting vulnerabilities
* [CHANGELOG.md](CHANGELOG.md)

## Development

```bash
cd server && npm ci && npm test              # unit + HTTP tests (Linux/macOS; some skip on Windows)
tests/integration/test-token-permissions.sh  # P0 regression (Linux/WSL, needs root or sudo)
tests/integration/test-compose.sh            # full stack e2e (Linux/macOS/WSL)
```

MCP protocol: SDK v2 (`@modelcontextprotocol/server`), serving the
2026-07-28 revision and 2025-era clients statelessly. See
[ADR-0003](docs/adr/0003-mcp-protocol-and-sdk.md).

## Licence

Not yet decided — see [ADR-0007](docs/adr/0007-license.md). Until a licence
file is added, all rights are reserved by the repository owner.
