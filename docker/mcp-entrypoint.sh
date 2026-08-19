#!/usr/bin/env bash
# MCPBox MCP container entrypoint.
#
# Runs as root only long enough to:
#   1. read the bearer token from the read-only mount (bind mount or Compose
#      secret) whose owner/UID is controlled by the host, not by us;
#   2. copy it into a container-private file owned by "agent" with mode 0400;
#   3. make sure the shared workspace directory exists and is writable by agent;
# and then drops privileges permanently with setpriv and execs node.
#
# This avoids the classic host-UID-1000 vs container-UID mismatch on native
# Linux without ever loosening the permission of the host secret file.
set -euo pipefail

TOKEN_SOURCE="${MCPBOX_TOKEN_FILE:-/run/secrets/mcpbox-token}"
RUNTIME_DIR=/run/mcpbox
TOKEN_TARGET="${RUNTIME_DIR}/token"
WORKDIR="${MCPBOX_WORKDIR:-/workspace/project}"
AGENT_USER=agent

log() { printf 'mcpbox-mcp: %s\n' "$*" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
  # Someone started the container with --user; we cannot fix ownership, but we
  # can still try to run if the token is readable as-is.
  log "not running as root; skipping privilege drop"
  if [[ ! -r "${TOKEN_SOURCE}" ]]; then
    log "token file ${TOKEN_SOURCE} is not readable by uid $(id -u)"
    exit 1
  fi
  exec node /opt/mcpbox/src/server.mjs
fi

if [[ ! -f "${TOKEN_SOURCE}" ]]; then
  log "token file not found at ${TOKEN_SOURCE}; run ./setup.sh or create runtime/mcpbox-token"
  exit 1
fi
if [[ ! -s "${TOKEN_SOURCE}" ]]; then
  log "token file ${TOKEN_SOURCE} is empty"
  exit 1
fi

install -d -m 0755 "${RUNTIME_DIR}"
# Copy (never chmod/chown the source; it belongs to the host).
install -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0400 "${TOKEN_SOURCE}" "${TOKEN_TARGET}"

# Shared workspace: make sure the project directory exists and belongs to agent.
install -d -m 0755 /workspace
if [[ ! -d "${WORKDIR}" ]]; then
  install -d -o "${AGENT_USER}" -g "${AGENT_USER}" -m 0755 "${WORKDIR}"
fi
# Only fix ownership of the top-level directory; recursive chown on a large
# workspace would be slow and surprising.
if [[ "$(stat -c %u "${WORKDIR}")" != "$(id -u "${AGENT_USER}")" ]]; then
  chown "${AGENT_USER}:${AGENT_USER}" "${WORKDIR}" || true
fi
ln -sfn "${WORKDIR}" /home/agent/project 2>/dev/null || true

export MCPBOX_TOKEN_FILE="${TOKEN_TARGET}"
export HOME=/home/agent
export USER="${AGENT_USER}"
export LOGNAME="${AGENT_USER}"

# --init-groups: supplementary groups of agent (none by default).
# no --reset-env: keep MCPBOX_* configuration passed by Compose.
exec setpriv --reuid="${AGENT_USER}" --regid="${AGENT_USER}" --init-groups \
  node /opt/mcpbox/src/server.mjs
