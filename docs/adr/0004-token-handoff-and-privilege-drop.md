# ADR-0004: Root entrypoint copies the token, then drops privileges

Status: accepted · Date: 2026-08-19

## Context (P0)

The old kit created `runtime/mcp-path-token` with `umask 077` (mode 0600,
owned by the host user — typically UID 1000 on native Linux) and bind-mounted
it into the MCP container, where Node ran as `agent`. The `node:22-bookworm`
image already owns UID 1000 (`node`), so `useradd agent` produced UID 1001 and
`readFileSync` failed with `EACCES`.

Reproduced on 2026-08-19 (Docker 28.3.2, WSL2 Ubuntu 24.04 host, Docker
Desktop WSL integration): file `1000:1000 0600` bind-mounted read-only →
`node -e readFileSync` as `-u 1001` → `EACCES: permission denied`; as
`-u 1000` → OK. `id node` in `node:22-bookworm` → `uid=1000`; `useradd agent`
→ `uid=1001`.

Rejected fixes:

* `chmod 0644` the token on the host — leaks the secret to every host user.
* Rely on matching UIDs — fragile across Docker Desktop, rootless Docker,
  corporate UID ranges.

## Decision

1. The mcp image's `ENTRYPOINT` is `tini -- mcpbox-mcp-entrypoint`, run as
   root.
2. The entrypoint `install -o agent -g agent -m 0400` copies the read-only
   mount (`/run/secrets/mcpbox-token`, bind mount or Compose secret) to
   `/run/mcpbox/token`, points `MCPBOX_TOKEN_FILE` at the copy, ensures
   `/workspace/project` exists and is agent-owned, and
   `exec setpriv --reuid=agent --regid=agent --init-groups node …`.
3. The image also pins `agent` to UID/GID 1000 by default (removing the
   unused `node` account) so any *deliberate* host bind mounts behave.
4. If the container is started with `--user`, the entrypoint skips the copy
   and only proceeds if the source is readable.

## Consequences

* The host token file keeps 0600 and host ownership.
* Node never runs as root; `ps` shows `node` under `agent`.
* Integration test `tests/integration/test-token-permissions.sh` runs the real
  image against a `1000:1000 0600` file created by a non-root host user (needs
  a Linux host or WSL2 with Docker integration).
