#!/usr/bin/env bash
# P0 regression test: the mcp image must start when the host token file is
# 0600 and owned by a UID that differs from the in-container "agent" user, and
# node must run as agent (not root) with an agent-owned 0400 copy of the token.
#
# Requires: docker, a Linux filesystem for the temp dir (native Linux, or WSL2
# with Docker Desktop integration; a Windows/NTFS mount will not preserve
# ownership and makes this test meaningless), permission to chown (root or sudo).
#
# Usage: tests/integration/test-token-permissions.sh [image]
set -euo pipefail

IMAGE="${1:-mcpbox-mcp:local}"
NAME="mcpbox-p0-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcpbox-p0.XXXXXX")"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else
    echo "need root or sudo to create files owned by other UIDs" >&2; exit 2
  fi
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

run_case() {
  local owner="$1" mode="$2" label="$3"
  local tokfile="$WORK/token-${owner%%:*}-${mode}"
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$tokfile"
  local token
  token="$(cat "$tokfile")" # read before chown: the test user may not be able to afterwards
  $SUDO chown "$owner" "$tokfile"
  $SUDO chmod "$mode" "$tokfile"

  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -v "$tokfile:/run/secrets/mcpbox-token:ro" \
    "$IMAGE" >/dev/null

  local ok=0
  for _ in $(seq 1 30); do
    if docker exec "$NAME" curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok=1; break; fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]]; then break; fi
    sleep 1
  done
  if [[ $ok -ne 1 ]]; then
    docker logs "$NAME" >&2 || true
    fail "$label: container did not become healthy"
  fi

  local user
  user="$(docker exec "$NAME" ps -o user= -C node | head -n1 | tr -d ' ')"
  [[ "$user" == "agent" ]] || fail "$label: node runs as '$user', expected agent"

  local perms
  perms="$(docker exec "$NAME" stat -c '%U:%G %a' /run/mcpbox/token)"
  [[ "$perms" == "agent:agent 400" ]] || fail "$label: runtime token is '$perms', expected 'agent:agent 400'"

  # Host file must be untouched.
  local hostperms
  hostperms="$(stat -c '%u %a' "$tokfile")"
  [[ "$hostperms" == "${owner%%:*} ${mode#0}" ]] || fail "$label: host token file changed to '$hostperms'"

  # The token must actually authenticate.
  local status
  status="$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/mcp \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' \
    -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"t","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}')"
  [[ "$status" == "200" ]] || fail "$label: authenticated request returned $status"

  pass "$label (owner $owner mode $mode): node as agent, token agent:agent 0400, auth 200"
}

run_case "1000:1000" 0600 "same-uid"
run_case "1234:1234" 0600 "different-uid"
run_case "0:0"       0600 "root-owned"
run_case "1234:1234" 0400 "read-only-different-uid"

echo "all token permission cases passed"
