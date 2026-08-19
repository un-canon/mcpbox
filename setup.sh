#!/usr/bin/env bash
# MCPBox first-run setup.
#
#   ./setup.sh ~/.ssh/id_ed25519.pub [--no-start] [--print-token]
#
# * validates the SSH public key and installs it as runtime/authorized_keys
# * generates runtime/mcpbox-token (256-bit random, base64url) if absent
# * creates .env from .env.example if absent
# * builds and starts the Compose stack and waits for the health endpoint
#
# Nothing here is ever committed: runtime/ and .env are git-ignored.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<'EOF'
Usage: ./setup.sh /path/to/id_ed25519.pub [--no-start] [--print-token]

  --no-start      prepare runtime/ and .env but do not build or start containers
  --print-token   print the bearer token to the terminal (default: only the path)
EOF
  exit 2
}

PUBLIC_KEY_FILE=""
START=1
PRINT_TOKEN=0
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --print-token) PRINT_TOKEN=1 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $arg" >&2; usage ;;
    *) [[ -z "$PUBLIC_KEY_FILE" ]] || usage; PUBLIC_KEY_FILE=$arg ;;
  esac
done
[[ -n "$PUBLIC_KEY_FILE" ]] || usage

# Docker Desktop on macOS does not always put docker on PATH for scripts.
if ! command -v docker >/dev/null 2>&1 \
  && [[ -x /Applications/Docker.app/Contents/Resources/bin/docker ]]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi

for command_name in openssl ssh-keygen; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done
if [[ $START -eq 1 ]]; then
  for command_name in docker curl; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "Missing required command: $command_name" >&2
      exit 1
    fi
  done
  docker compose version >/dev/null
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is installed but its daemon is not running; start Docker and retry" >&2
    exit 1
  fi
fi

# --- Public key validation --------------------------------------------------
if [[ ! -f "$PUBLIC_KEY_FILE" ]]; then
  echo "Public key file not found: $PUBLIC_KEY_FILE" >&2
  exit 1
fi
if grep -q 'PRIVATE KEY' "$PUBLIC_KEY_FILE"; then
  echo "Refusing a private key; pass the .pub file instead" >&2
  exit 1
fi
if ! grep -Eq '^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) ' "$PUBLIC_KEY_FILE"; then
  echo "Not an OpenSSH public key line: $PUBLIC_KEY_FILE" >&2
  exit 1
fi
if ! ssh-keygen -l -f "$PUBLIC_KEY_FILE" >/dev/null 2>&1; then
  echo "Not a valid SSH public key: $PUBLIC_KEY_FILE" >&2
  exit 1
fi

# --- Runtime material -------------------------------------------------------
umask 077
mkdir -p runtime
install -m 0600 "$PUBLIC_KEY_FILE" runtime/authorized_keys

# Legacy name from ssh-mcp-four-tools-kit; migrate silently.
if [[ -s runtime/mcp-path-token && ! -s runtime/mcpbox-token ]]; then
  mv runtime/mcp-path-token runtime/mcpbox-token
fi
if [[ ! -s runtime/mcpbox-token ]]; then
  # 32 random bytes, base64url without padding (43 chars).
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > runtime/mcpbox-token
  printf '\n' >> runtime/mcpbox-token
fi
chmod 0600 runtime/mcpbox-token

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

if [[ $START -eq 0 ]]; then
  printf 'Prepared runtime/authorized_keys, runtime/mcpbox-token and .env. Not starting (--no-start).\n'
  exit 0
fi

# --- Build & start ----------------------------------------------------------
docker compose config >/dev/null
docker compose up -d --build

MCP_BINDING="$(docker compose port mcp 3000 | tail -n 1)"
HEALTH_URL="http://${MCP_BINDING}/healthz"
for _ in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "$HEALTH_URL" >/dev/null; then
  echo "MCP service did not become healthy; see: docker compose logs mcp" >&2
  exit 1
fi

SSH_BINDING="$(docker compose port workbench 22 | tail -n 1)"
MCP_URL="http://${MCP_BINDING}/mcp"

printf '\nReady.\n\n'
printf 'MCP endpoint (Streamable HTTP, bearer auth):\n  %s\n' "$MCP_URL"
printf 'Bearer token file (keep private, 0600):\n  %s/runtime/mcpbox-token\n\n' "$ROOT"
if [[ $PRINT_TOKEN -eq 1 ]]; then
  printf 'Token:\n  %s\n\n' "$(tr -d '\r\n' < runtime/mcpbox-token)"
fi
# shellcheck disable=SC2016  # the $(cat ...) is meant to be printed literally
printf 'Claude Code:\n  claude mcp add --transport http --scope user mcpbox %s \\\n    --header "Authorization: Bearer $(cat %s/runtime/mcpbox-token)"\n\n' "$MCP_URL" "$ROOT"
printf 'SSH:\n  ssh -p %s agent@%s\n\n' "${SSH_BINDING##*:}" "${SSH_BINDING%:*}"
printf 'See README.md for Codex, remote tunnelling and the security model.\n'
