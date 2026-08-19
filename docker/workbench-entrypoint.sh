#!/usr/bin/env bash
# MCPBox workbench (SSH) container entrypoint. Runs as root; sshd itself drops
# to the "agent" account for sessions.
set -euo pipefail

AUTHORIZED_KEYS_SOURCE=/run/mcpbox/authorized_keys
HOSTKEY_DIR=/run/mcpbox-hostkeys
WORKDIR="${MCPBOX_WORKDIR:-/workspace/project}"

log() { printf 'mcpbox-workbench: %s\n' "$*" >&2; }

if [[ ! -s "${AUTHORIZED_KEYS_SOURCE}" ]]; then
  log "runtime/authorized_keys is missing or empty; run ./setup.sh <key.pub>"
  exit 1
fi
if grep -q 'PRIVATE KEY' "${AUTHORIZED_KEYS_SOURCE}"; then
  log "runtime/authorized_keys contains a private key; refusing to start"
  exit 1
fi

# OpenSSH refuses every login for a locked account ("!" in the shadow field)
# before it even checks the public key. Keep the account unlocked but without a
# password. sshd_config disables password authentication and empty passwords,
# so this cannot be used to log in.
passwd -d agent >/dev/null
install -d -o agent -g agent -m 0700 /home/agent/.ssh
install -o agent -g agent -m 0600 \
  "${AUTHORIZED_KEYS_SOURCE}" /home/agent/.ssh/authorized_keys

install -d -m 0700 "${HOSTKEY_DIR}"
if [[ ! -s "${HOSTKEY_DIR}/ssh_host_ed25519_key" ]]; then
  log "generating persistent ed25519 host key"
  ssh-keygen -q -t ed25519 -N '' -f "${HOSTKEY_DIR}/ssh_host_ed25519_key"
fi
chmod 0600 "${HOSTKEY_DIR}/ssh_host_ed25519_key"

install -d -m 0755 /workspace
if [[ ! -d "${WORKDIR}" ]]; then
  install -d -o agent -g agent -m 0755 "${WORKDIR}"
fi
if [[ "$(stat -c %u "${WORKDIR}")" != "$(id -u agent)" ]]; then
  chown agent:agent "${WORKDIR}" || true
fi

if [[ -n "${MCPBOX_REPO_URL:-}" && ! -d "${WORKDIR}/.git" ]]; then
  if [[ -z "$(find "${WORKDIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    log "cloning ${MCPBOX_REPO_URL} into ${WORKDIR}"
    if ! sudo -u agent git clone -- "${MCPBOX_REPO_URL}" "${WORKDIR}"; then
      log "clone failed; continuing with an empty workspace"
    fi
  else
    log "MCPBOX_REPO_URL is set but ${WORKDIR} is not empty; clone skipped"
  fi
fi

ln -sfn "${WORKDIR}" /home/agent/project
if [[ -d "${WORKDIR}/.git" ]]; then
  if [[ -n "${MCPBOX_GIT_USER_NAME:-}" ]]; then
    sudo -u agent git -C "${WORKDIR}" config user.name "${MCPBOX_GIT_USER_NAME}"
  fi
  if [[ -n "${MCPBOX_GIT_USER_EMAIL:-}" ]]; then
    sudo -u agent git -C "${WORKDIR}" config user.email "${MCPBOX_GIT_USER_EMAIL}"
  fi
fi

/usr/sbin/sshd -t
exec /usr/sbin/sshd -D -e
