#!/usr/bin/env bash
# End-to-end test of the Compose stack in an isolated project:
#   * setup.sh with a throw-away SSH key (build + start + health)
#   * MCP: bearer auth, tools/list, exec_command, write_stdin terminate,
#     process-group cleanup, apply_patch, view_image
#   * SSH: key-only login as agent, shared /workspace visible from both sides,
#     password/root login refused
#   * host/origin rejection through the published port
#   * teardown removes containers and the test volumes
#
# Requires: docker (compose v2), ssh, ssh-keygen, curl, python3 or jq-free
# parsing (uses grep). Uses ports 22299/33399 by default. Runs on Linux, macOS
# or WSL2; on Windows run it from WSL.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="mcpboxtest$$"
SSH_PORT="${MCPBOX_TEST_SSH_PORT:-22299}"
MCP_PORT="${MCPBOX_TEST_MCP_PORT:-33399}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcpbox-e2e.XXXXXX")"
export COMPOSE_PROJECT_NAME="$PROJECT"

restore() {
  cd "$ROOT"
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f .env
  if [[ -f "$WORK/.env.user-backup" ]]; then mv "$WORK/.env.user-backup" .env; fi
  rm -rf runtime
  if [[ -d "runtime.e2e-backup.$$" ]]; then mv "runtime.e2e-backup.$$" runtime; fi
  rm -rf "$WORK"
}
trap restore EXIT

fail() { echo "FAIL: $*" >&2; docker compose logs --tail=50 mcp workbench >&2 || true; exit 1; }
pass() { echo "ok: $*"; }

cd "$ROOT"

# Never clobber a real runtime/ or .env: stash them during the test.
if [[ -d runtime ]]; then mv runtime "runtime.e2e-backup.$$"; fi
if [[ -f .env ]]; then mv .env "$WORK/.env.user-backup"; fi

ssh-keygen -q -t ed25519 -N "" -f "$WORK/id_ed25519"
cat > .env <<EOF
MCPBOX_SSH_PORT=$SSH_PORT
MCPBOX_MCP_PORT=$MCP_PORT
MCPBOX_MAX_SESSIONS=4
MCPBOX_KILL_GRACE_MS=1000
MCPBOX_IMAGE_TAG=e2e
EOF

./setup.sh "$WORK/id_ed25519.pub" >"$WORK/setup.log" 2>&1 || { cat "$WORK/setup.log" >&2; fail "setup.sh failed"; }
grep -q "Ready." "$WORK/setup.log" || fail "setup.sh did not report Ready"
pass "setup.sh built and started the stack"

TOKEN="$(tr -d '\r\n' < runtime/mcpbox-token)"
BASE="http://127.0.0.1:$MCP_PORT"
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"e2e","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}'

mcp() { # method name json-args
  local method="$1" name="${2:-}" args="${3:-{\}}"
  local body headers=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2026-07-28' -H "Mcp-Method: $method")
  if [[ "$method" == "tools/call" ]]; then
    headers+=(-H "Mcp-Name: $name")
    body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args,$META}}"
  else
    body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":{$META}}"
  fi
  curl -sS -X POST "$BASE/mcp" "${headers[@]}" -d "$body"
}
json_get() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

# --- auth -------------------------------------------------------------------
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{}')"
[[ "$code" == "401" ]] || fail "unauthenticated POST returned $code, expected 401"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "Authorization: Bearer ${TOKEN}x" -H 'Content-Type: application/json' -d '{}')"
[[ "$code" == "401" ]] || fail "wrong token returned $code"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/$TOKEN/mcp" -H 'Content-Type: application/json' -d '{}')"
[[ "$code" == "404" ]] || fail "legacy path token should be 404 when disabled, got $code"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" -H 'Origin: http://evil.example' -H 'Content-Type: application/json' -d '{}')"
[[ "$code" == "403" ]] || fail "hostile Origin returned $code, expected 403"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" -H 'Host: evil.example' -H 'Content-Type: application/json' -d '{}')"
[[ "$code" == "421" ]] || fail "hostile Host returned $code, expected 421"
pass "auth / origin / host guards on the published port"

# --- tools ------------------------------------------------------------------
tools="$(mcp tools/list | json_get "sorted(t['name'] for t in d['result']['tools'])")"
[[ "$tools" == "['apply_patch', 'exec_command', 'view_image', 'write_stdin']" ]] || fail "tools/list gave $tools"
pass "tools/list"

out="$(mcp tools/call exec_command '{"cmd":"id -un; sudo -n id -un; pwd; echo héllo > /workspace/project/from-mcp.txt"}' | json_get "d['result']['structuredContent']['output']")"
[[ "$out" == $'agent\nroot\n/workspace/project' ]] || fail "exec_command output unexpected: $out"
pass "exec_command runs as agent with sudo in /workspace/project"

# process-group cleanup: background grandchild must die with the session
sid="$(mcp tools/call exec_command '{"cmd":"(sleep 600 &) ; echo $$ > /tmp/e2e.pid; sleep 600","yield_time_ms":300}' | json_get "d['result']['structuredContent']['session_id']")"
[[ -n "$sid" && "$sid" != "None" ]] || fail "no session id"
before="$(docker compose exec -T mcp sh -c 'pgrep -c -x sleep || true')"
[[ "$before" -ge 2 ]] || fail "expected >=2 sleep processes before terminate, saw $before"
term="$(mcp tools/call write_stdin "{\"session_id\":\"$sid\",\"terminate\":true,\"yield_time_ms\":5000}" | json_get "d['result']['structuredContent']['status']+' '+str(d['result']['structuredContent']['terminated_by'])")"
[[ "$term" == "completed client" ]] || fail "terminate result: $term"
sleep 1
after="$(docker compose exec -T mcp sh -c 'pgrep -c -x sleep || true')"
[[ "$after" == "0" ]] || fail "sleep processes left after terminate: $after"
pass "write_stdin terminate kills the whole process group (grandchild included)"

# apply_patch + view_image
mcp tools/call exec_command '{"cmd":"cd /workspace/project && git init -q 2>/dev/null; python3 -c \"import zlib,struct; raw=b\\\"\\\\x00\\\\xff\\\\x00\\\\x00\\\"; ihdr=struct.pack(\\\">IIBBBBB\\\",1,1,8,2,0,0,0); import binascii; c=lambda t,d: struct.pack(\\\">I\\\",len(d))+t+d+struct.pack(\\\">I\\\",binascii.crc32(t+d)&0xffffffff); open(\\\"px.png\\\",\\\"wb\\\").write(b\\\"\\\\x89PNG\\\\r\\\\n\\\\x1a\\\\n\\\"+c(b\\\"IHDR\\\",ihdr)+c(b\\\"IDAT\\\",zlib.compress(raw))+c(b\\\"IEND\\\",b\\\"\\\"))\""}' >/dev/null
patch='--- /dev/null\n+++ b/new-file.txt\n@@ -0,0 +1 @@\n+created by apply_patch\n'
res="$(mcp tools/call apply_patch "{\"patch\":\"$patch\"}" | json_get "str(d['result']['structuredContent'].get('applied'))+' '+str(d['result']['structuredContent'].get('new_untracked_files'))")"
[[ "$res" == "True ['new-file.txt']" ]] || fail "apply_patch: $res"
pass "apply_patch reports the new untracked file"
mime="$(mcp tools/call view_image '{"path":"px.png"}' | json_get "d['result']['content'][0]['type']+' '+d['result']['content'][0]['mimeType']")"
[[ "$mime" == "image image/png" ]] || fail "view_image: $mime"
pass "view_image returns image/png by content"

# --- SSH --------------------------------------------------------------------
SSH=(ssh -p "$SSH_PORT" -i "$WORK/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes)
for _ in $(seq 1 30); do
  if "${SSH[@]}" agent@127.0.0.1 true 2>/dev/null; then break; fi
  sleep 1
done
who="$("${SSH[@]}" agent@127.0.0.1 'id -un; cat /workspace/project/from-mcp.txt; ls ~/project/new-file.txt')"
[[ "$who" == $'agent\nhéllo\n/home/agent/project/new-file.txt' ]] || fail "ssh output: $who"
pass "ssh key login as agent; files written via MCP visible over SSH (shared workspace)"

"${SSH[@]}" agent@127.0.0.1 'sudo -n id -un | grep -qx root && ! pgrep -x node >/dev/null' || fail "workbench: sudo missing or MCP node process visible (containers must not share processes)"
pass "workbench has sudo, and does not see the mcp container's processes"

if ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes -o PubkeyAuthentication=no agent@127.0.0.1 true 2>/dev/null; then
  fail "ssh without a key succeeded"
fi
if "${SSH[@]}" root@127.0.0.1 true 2>/dev/null; then fail "root ssh login succeeded"; fi
pass "password and root SSH logins refused"

# --- resource limits applied ------------------------------------------------
pids="$(docker inspect -f '{{.HostConfig.PidsLimit}}' "${PROJECT}-mcp-1")"
mem="$(docker inspect -f '{{.HostConfig.Memory}}' "${PROJECT}-mcp-1")"
[[ "$pids" == "1024" && "$mem" == "4294967296" ]] || fail "limits not applied: pids=$pids mem=$mem"
pass "compose resource limits applied (pids=$pids, memory=$mem)"

# --- graceful shutdown leaves no processes -----------------------------------
docker compose stop -t 15 mcp >/dev/null
state="$(docker inspect -f '{{.State.ExitCode}}' "${PROJECT}-mcp-1")"
[[ "$state" == "0" ]] || fail "mcp container exit code on SIGTERM: $state"
pass "mcp shuts down cleanly on SIGTERM (exit 0)"

echo "ALL COMPOSE E2E CHECKS PASSED"
