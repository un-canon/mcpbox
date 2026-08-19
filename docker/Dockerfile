# syntax=docker/dockerfile:1.7
#
# MCPBox images.
#
#   base       shared toolchain + unprivileged "agent" user with passwordless sudo
#   workbench  OpenSSH server (key-only) exposing the shared /workspace
#   mcp        Node.js MCP server exposing exec_command / write_stdin /
#              apply_patch / view_image over Streamable HTTP
#
# Both runtime images start as root under tini so their entrypoints can fix
# ownership of mounted material, then drop privileges to "agent".

ARG NODE_IMAGE=node:22-bookworm

FROM ${NODE_IMAGE} AS base

ARG AGENT_UID=1000
ARG AGENT_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash-completion build-essential ca-certificates curl file git git-lfs jq \
       less nano openssh-client python3 python3-pip python3-venv ripgrep rsync \
       shellcheck sudo tini tmux unzip util-linux vim wget xz-utils zip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# The official node image ships a "node" user at UID/GID 1000. MCPBox wants a
# predictable UID for the workbench user so files created in the shared
# workspace (and any deliberately opted-in host bind mounts) have a stable owner.
# If the requested UID/GID is already taken by "node", remove that account first.
RUN set -eu; \
    if getent passwd node >/dev/null && [ "$(id -u node)" = "${AGENT_UID}" ]; then userdel -r node; fi; \
    if getent group "${AGENT_GID}" >/dev/null; then \
      existing="$(getent group "${AGENT_GID}" | cut -d: -f1)"; \
      if [ "${existing}" != "agent" ]; then groupdel "${existing}"; fi; \
    fi; \
    groupadd --gid "${AGENT_GID}" agent; \
    useradd --uid "${AGENT_UID}" --gid agent --create-home --shell /bin/bash agent; \
    printf '%s\n' 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent; \
    chmod 0440 /etc/sudoers.d/agent; \
    install -d -m 0755 /workspace; \
    install -d -o agent -g agent -m 0700 /home/agent/.ssh

# ---------------------------------------------------------------------------
FROM base AS workbench

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && install -d -m 0755 /run/sshd \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY docker/sshd_config /etc/ssh/sshd_config
COPY --chmod=0755 docker/workbench-entrypoint.sh /usr/local/bin/mcpbox-workbench-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/mcpbox-workbench-entrypoint"]

# ---------------------------------------------------------------------------
FROM base AS mcp

WORKDIR /opt/mcpbox
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server/src ./src
COPY --chmod=0755 docker/mcp-entrypoint.sh /usr/local/bin/mcpbox-mcp-entrypoint

# MCPBOX_TOKEN_FILE is the *path* of a mounted secret, not the secret itself.
# hadolint ignore=DL3064
ENV MCPBOX_PORT=3000 \
    MCPBOX_TOKEN_FILE=/run/secrets/mcpbox-token \
    MCPBOX_WORKDIR=/workspace/project

EXPOSE 3000
# Starts as root; the entrypoint copies the token into a private runtime file
# owned by "agent" and then execs node as "agent" (see docs/adr/0004).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/mcpbox-mcp-entrypoint"]
