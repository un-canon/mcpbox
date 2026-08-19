# Architecture

MCPBox is two containers built from one Dockerfile, sharing one named volume.

```text
 Codex / Claude Code / any MCP client            you (terminal)
              │                                        │
              │ HTTP POST /mcp                         │ ssh -p 22222 agent@127.0.0.1
              │ Authorization: Bearer <token>          │ (public key only)
              ▼                                        ▼
 ┌───────────────────────────┐          ┌───────────────────────────┐
 │  mcp container            │          │  workbench container      │
 │  node  (user: agent)      │          │  sshd   (login: agent)    │
 │  tools:                   │          │                           │
 │   exec_command            │          │  agent has passwordless   │
 │   write_stdin             │          │  sudo, network, apt       │
 │   apply_patch             │          │                           │
 │   view_image              │          │                           │
 │  agent has passwordless   │          │                           │
 │  sudo, network, apt       │          │                           │
 └────────────┬──────────────┘          └────────────┬──────────────┘
              │      named volume  workspace         │
              └──────────────► /workspace ◄──────────┘
                              (/workspace/project)
```

Host port bindings (defaults): `127.0.0.1:33333 → mcp:3000`, `127.0.0.1:22222 → workbench:22`.

## What is shared — and what is not

The two containers share **only** the `workspace` volume, mounted at
`/workspace` in both. Everything else is separate:

| Shared | Not shared |
| --- | --- |
| `/workspace` (files, Git working tree, build outputs written there) | process list (`ps` in one does not show the other's processes) |
| | `/tmp`, `/var`, `/home/agent` and the rest of the root filesystem |
| | packages installed with `apt`, `pip --user`, `npm -g` |
| | system configuration (`/etc`), environment variables |
| | background services started in one container |

Consequences you will notice:

* `sudo apt install foo` through `exec_command` does **not** make `foo`
  available in your SSH session, and vice-versa.
* A dev server started over SSH is not visible to `exec_command`'s `ps`, and
  is reachable from the mcp container only over the Compose network
  (`http://workbench:PORT`), not on `localhost`.
* Rebuilding the images (`docker compose up -d --build`) keeps
  `/workspace/project` (it lives in the volume) but discards anything installed
  into the container root filesystem. Put reproducible setup in the project
  itself (scripts, `requirements.txt`, `package.json`, …), or bake it into the
  image via a custom `Dockerfile` layered on top.

This split is deliberate: the mcp container never sees SSH host keys or
`authorized_keys`, and the workbench never sees the MCP bearer token.

## Process model

* Both images use `tini` as PID 1 (zombie reaping, signal forwarding).
* Both entrypoints run as root just long enough to fix ownership of mounted
  material, then drop privileges (`setpriv` in mcp; sshd session login in
  workbench). See [ADR-0004](adr/0004-token-handoff-and-privilege-drop.md).
* Every `exec_command` session runs in its own process group. Termination is
  SIGTERM → grace period → SIGKILL to the **group**, so background children
  started by the command die too. See
  [ADR-0006](adr/0006-process-lifecycle.md).

## Persistence

| Volume | Content | Survives `down` | Survives `down --volumes` |
| --- | --- | --- | --- |
| `workspace` | `/workspace/project` | yes | **no** |
| `ssh-hostkeys` | workbench ed25519 host key | yes | **no** |

`runtime/authorized_keys` and `runtime/mcpbox-token` live on the host, are
read-only in the containers, and are git-ignored.

## Source layout

```text
compose.yaml           two services, resource limits, env-driven config
setup.sh               first-run helper (key validation, token, build, health wait)
docker/Dockerfile      base → workbench, base → mcp
docker/*-entrypoint.sh root bootstrap + privilege drop
docker/sshd_config     key-only sshd
server/src/            MCP server (Node.js, ESM, no build step)
  server.mjs           entrypoint: config, token, HTTP listener, shutdown
  http.mjs             request pipeline: host/origin/auth guards → MCP transport
  mcp.mjs              MCP server + tool registration (schemas, annotations)
  tools.mjs            tool logic (exec/stdin/patch/image), transport-agnostic
  process-manager.mjs  sessions, process groups, limits
  auth.mjs, token.mjs  guards and token handling
  config.mjs           env → config
server/test/           node:test unit tests
tests/integration/     bash + Docker end-to-end tests
docs/                  this file, security model, configuration, ADRs
```
