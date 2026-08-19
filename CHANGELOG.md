# Changelog

All notable changes to MCPBox. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-08-19

First release under the MCPBox name. A rewrite of the unpublished
`ssh-mcp-four-tools-kit` (SHA-256 `cc7c27c5…08d54`) with the following
changes.

### Security
- Bearer-token authentication (`Authorization: Bearer`) at a fixed `/mcp`
  path; token in the URL path is now opt-in (`MCPBOX_LEGACY_PATH_TOKEN=1`) and
  deprecated. Failures return generic 401/404 and never echo the token.
- `Origin` validation (DNS-rebinding) in addition to `Host` validation, both
  with allow-lists.
- Token file handoff: the mcp container starts as root, copies the read-only
  token mount to an agent-owned 0400 file and drops to `agent` with
  `setpriv`. Fixes `EACCES` on native Linux when host UID ≠ container UID.
- Token validation checks charset and distinct-character count, compared in
  constant time.
- Container resource limits (CPU, memory, PIDs, nofile) and server limits
  (concurrent sessions, runtime, idle timeout, buffer, request concurrency,
  image size), all configurable.
- Process groups for every session; SIGTERM → SIGKILL escalation; cleanup on
  shutdown; no orphaned grandchildren.
- sshd: `AuthenticationMethods publickey`, `PermitEmptyPasswords no`,
  `AllowStreamLocalForwarding no`, `PermitUserRC no`.
- `setup.sh` rejects private keys and non-OpenSSH public key formats.

### Changed
- MCP SDK: `@modelcontextprotocol/sdk` 1.30.0 → `@modelcontextprotocol/server`
  + `/node` 2.0.0; serves MCP 2026-07-28 and 2025-era clients statelessly.
- Server name `ssh-mcp-four-tools` 0.1.0 → `mcpbox` 1.0.0 (matches
  `package.json`).
- `.env` variables renamed with an `MCPBOX_` prefix; agent UID/GID fixed at
  1000 (build args).
- `view_image`: format detected by content (magic bytes), size cap
  configurable, `detail` parameter removed.
- `apply_patch`: reports untracked new files, handles non-Git directories
  explicitly.
- Output decoding via `StringDecoder` (no broken multi-byte UTF-8).
- Structured JSON logs to stderr; tokens never logged.

### Added
- Unit + HTTP end-to-end tests (`node:test`), Docker integration tests, CI
  workflow, ADRs, security model, architecture and configuration docs.

[Unreleased]: https://github.com/un-canon/mcpbox/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/un-canon/mcpbox/releases/tag/v1.0.0
