# Configuration reference

All settings live in `.env` (copy from `.env.example`). Compose substitutes
them into `compose.yaml`; the server reads the `MCPBOX_*` variables from its
environment. Restart with `docker compose up -d` after changes (image-level
settings such as `MCPBOX_AGENT_UID` need `--build`).

## Network

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPBOX_SSH_BIND` | `127.0.0.1` | Host address for the SSH port. `0.0.0.0` on a remote box you reach over SSH. |
| `MCPBOX_SSH_PORT` | `22222` | Host SSH port. |
| `MCPBOX_MCP_PORT` | `33333` | Host MCP port. Always bound to `127.0.0.1`. |
| `TZ` | `UTC` | Container timezone. |

## Identity

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPBOX_AGENT_UID` / `MCPBOX_AGENT_GID` | `1000` | UID/GID of the in-container `agent` user (build arg). Match your host user only if you deliberately bind mount host directories. |

## Workspace bootstrap (workbench)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPBOX_REPO_URL` | empty | Clone once into `/workspace/project` if it is empty. Public or pre-authenticated HTTPS URLs only; do not put credentials in the URL. |
| `MCPBOX_GIT_USER_NAME` / `MCPBOX_GIT_USER_EMAIL` | empty | Repository-local Git identity. |

## Container resource limits (Compose)

| Variable | Default | Applies to |
| --- | --- | --- |
| `MCPBOX_MCP_CPUS` | `2` | mcp `cpus` |
| `MCPBOX_MCP_MEMORY` | `4g` | mcp `mem_limit` and `memswap_limit` (no swap beyond RAM) |
| `MCPBOX_MCP_PIDS` | `1024` | mcp `pids_limit` |
| `MCPBOX_WORKBENCH_CPUS` | `2` | workbench `cpus` |
| `MCPBOX_WORKBENCH_MEMORY` | `4g` | workbench memory |
| `MCPBOX_WORKBENCH_PIDS` | `2048` | workbench `pids_limit` |
| `MCPBOX_NOFILE` | `65536` | open-file ulimit (both) |

Guidance: a Rust/C++ build or a large `npm install` needs more than 2 CPUs and
4 GiB to be pleasant; raise the mcp limits on a beefy machine. Do not remove
the PID limit — fork bombs are the easiest way for a confused agent to freeze a
host.

## MCP server limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPBOX_MAX_SESSIONS` | `16` | Concurrently *running* `exec_command` sessions. New sessions fail with a clear error beyond this. |
| `MCPBOX_MAX_RUNTIME_MS` | `3600000` (1 h) | Hard wall-clock limit per session; SIGTERM → SIGKILL to the process group. |
| `MCPBOX_IDLE_TIMEOUT_MS` | `1800000` (30 min) | A running session that no client polls or writes to for this long is terminated. |
| `MCPBOX_KILL_GRACE_MS` | `5000` | Time between SIGTERM and SIGKILL. |
| `MCPBOX_MAX_BUFFER_CHARS` | `2000000` | Unread output kept per session; oldest output is dropped and counted in `dropped_chars`. |
| `MCPBOX_MAX_RESULT_CHARS` | `100000` | Upper bound of `max_output_chars` per tool call. |
| `MCPBOX_MAX_IMAGE_BYTES` | `12582912` (12 MiB) | `view_image` size cap. |
| `MCPBOX_MAX_CONCURRENT_REQUESTS` | `32` | In-flight HTTP requests before the server answers `503`. |
| `MCPBOX_FINISHED_RETENTION_MS` | `3600000` | How long finished sessions with unread output stay pollable. |
| `MCPBOX_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Tokens are never logged at any level. |

## HTTP hardening

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPBOX_ALLOWED_HOSTS` | `127.0.0.1,localhost,mcp` | Accepted `Host` header hostnames (port ignored). `mcp` is needed for `ssh -L 33333:mcp:3000`. `*` disables the check (not recommended). |
| `MCPBOX_ALLOWED_ORIGINS` | empty | Extra exact origins (e.g. `https://inspector.example`) allowed in addition to any origin whose host is in `MCPBOX_ALLOWED_HOSTS`. `*` disables the check. |
| `MCPBOX_LEGACY_PATH_TOKEN` | `0` | **Deprecated.** `1` also accepts `POST /<token>/mcp` for clients configured for the old kit. |
| `MCPBOX_MCP_PATH` | `/mcp` | Endpoint path (server-only variable; not in `.env.example`). |

## Opt-in: mounting host directories

Not configured by default. If you want the agent to work on a host directory
instead of the named volume, add a bind mount to **both** services in a
`compose.override.yaml`:

```yaml
services:
  workbench:
    volumes:
      - /home/me/code/project:/workspace/project
  mcp:
    volumes:
      - /home/me/code/project:/workspace/project
```

Set `MCPBOX_AGENT_UID`/`GID` to your host UID/GID and rebuild so files stay
yours. Understand that the agent now has full read/write on that directory and,
through symlinks or Git hooks, potentially more. Never mount your whole home
directory, `~/.ssh`, `~/.aws`, `~/.config/gh`, or the Docker socket.
