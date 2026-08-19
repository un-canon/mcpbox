# Security model

Read this before exposing MCPBox to anything other than your own laptop.

## What MCPBox is

MCPBox gives an MCP client **arbitrary command execution inside a container**.
`exec_command` runs any Bash command; the `agent` account has passwordless
`sudo` and outbound network access. `apply_patch` and `view_image` are
conveniences — anything they do can also be done through `exec_command`.

Therefore:

* **"Four tools" is not least privilege.** The tool surface is small, but one
  of the tools is a shell with root-equivalent power inside the container.
* **The container is the trust boundary.** Whoever holds the bearer token (or
  can reach the endpoint through an SSH tunnel) can do anything the container
  can do: read/modify/delete the whole workspace, install software, make
  outbound network connections, consume CPU/RAM/disk up to the configured
  limits.
* **This is a single-user, fully-trusting-the-client design.** All clients
  share one workspace, one process table, one session namespace. There is no
  per-client identity, scope, expiry, revocation or audit trail beyond
  container logs.

## Suitable / unsuitable

Suitable for:

* one developer, one or more coding agents they trust, on their own machine;
* a personal remote dev box reached over SSH (SSH tunnel for MCP);
* work where the model may have root inside a disposable container.

Not suitable for:

* multiple users or tenants;
* an MCP endpoint reachable from the public internet;
* running against production infrastructure or credentials;
* regulated data;
* untrusted models or untrusted MCP clients;
* environments that need per-tool authorization, approval flows or audit.

## Network exposure

| Port | Default binding | Rule |
| --- | --- | --- |
| MCP `33333` | `127.0.0.1` (not configurable in `compose.yaml`) | **Never** publish to a non-loopback address. Remote clients use `ssh -N -L 33333:mcp:3000 …`, a VPN, or an authenticating reverse proxy that you operate. |
| SSH `22222` | `127.0.0.1` | May be bound to `0.0.0.0` on a remote host; firewall it. Key-only, `agent` user only. |

Inside the container the MCP server listens on `0.0.0.0:3000` (Compose
networking needs that); the host-side loopback binding is what keeps it
private.

## Authentication

* Bearer token in the `Authorization` header at a fixed path `/mcp`
  ([ADR-0002](adr/0002-bearer-token-authentication.md)).
* Token: 32 random bytes from `openssl rand`, base64url. Compared in constant
  time. Never logged.
* Missing/invalid token → `401` with a generic message. Wrong host → `421`.
  Disallowed `Origin` → `403`.
* Legacy path-token mode (`/<token>/mcp`) exists only for migrating from
  `ssh-mcp-four-tools-kit`, is off by default and returns `404` when off. It is
  deprecated because tokens in URLs end up in logs, history and proxies.
* This is a shared secret, not OAuth. It is adequate behind loopback + SSH; it
  is not internet-grade authentication.

## Host / Origin validation (DNS-rebinding)

* `Host` must be in `MCPBOX_ALLOWED_HOSTS` (default `127.0.0.1,localhost,mcp`).
* If an `Origin` header is present its host must be in the same list or the
  full origin must be in `MCPBOX_ALLOWED_ORIGINS`; `Origin: null` is rejected.
  Requests without `Origin` (CLIs) are accepted.

## What is deliberately not mounted

* Docker socket (`/var/run/docker.sock`) — would be full host root.
* Your home directory or any host project directory.
* SSH agent socket, SSH private keys.
* Cloud credentials, deploy keys, GitHub tokens, `.npmrc`, `.gitconfig`.

If you add such mounts you extend the blast radius from "the container" to
"whatever those credentials reach". Do it knowingly, and read
[docs/configuration.md](configuration.md) first.

## Resource limits

`compose.yaml` sets CPU, memory (+swap), PID and open-file limits per
container; the server caps concurrent sessions, per-session runtime, idle
time, unread output, in-flight requests and image size. Defaults are in
`.env.example`. Not covered by default:

* **Disk**: the `workspace` volume has no quota; a runaway process can fill the
  Docker data root. Watch `docker system df`, or put Docker's data root on a
  dedicated filesystem/quota.
* **Network egress**: the containers can reach anything the host can, including
  your LAN. Use a Docker network with egress rules, a firewall on the host, or
  `network_mode` restrictions if that matters to you.

## What container isolation does not do

Docker isolation is a Linux namespace/cgroup boundary, not a hypervisor:

* it does not protect against kernel vulnerabilities — keep the host patched;
* `sudo` inside the container means the process can use every capability
  Docker grants containers by default (no `--privileged` is used, and no extra
  capabilities are added, but the default set is not empty);
* Docker Desktop (macOS/Windows) adds a VM boundary; native Linux does not.

## Secrets hygiene

* `runtime/` and `.env` are git-ignored and docker-ignored.
* The token file is bind-mounted read-only; the mcp entrypoint copies it to an
  agent-owned `0400` file and drops privileges before starting Node
  ([ADR-0004](adr/0004-token-handoff-and-privilege-drop.md)).
* The workbench never receives the token; the mcp container never receives
  SSH keys.
* Rotate the token: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' > runtime/mcpbox-token && docker compose restart mcp`.

## Reporting

See [SECURITY.md](../SECURITY.md).
