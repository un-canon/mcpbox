# ADR-0008: Host and Origin validation

Status: accepted · Date: 2026-08-19

## Context

The MCP Streamable HTTP transport requires servers to validate the `Origin`
header to prevent DNS-rebinding attacks and recommends binding to localhost.
The old kit validated only `Host` (via the SDK v1 `createMcpExpressApp`
`allowedHosts`) and did not check `Origin`.

## Decision

Implemented in `server/src/auth.mjs`, applied before authentication:

* `Host` hostname must be in `MCPBOX_ALLOWED_HOSTS` (default
  `127.0.0.1,localhost,mcp`); missing → 400, other → 421.
* `Origin`, when present, must have its hostname in the same allow-list (any
  port, http/https) **or** match an entry of `MCPBOX_ALLOWED_ORIGINS` exactly.
  `Origin: null`, opaque or non-http(s) origins → 403.
* Absent `Origin` is accepted: the concern is browser-initiated cross-origin
  requests; CLIs and SDK clients do not send it, and rejecting them would
  break every non-browser client. This matches the behaviour of the official
  TypeScript SDK's DNS-rebinding protection (validates Origin only when
  present).
* `*` in either list disables that check (documented as not recommended).

## Consequences

Unit tests cover each branch; the integration test sends a hostile Origin and
Host and expects 403/421.
