# ADR-0003: MCP protocol version and TypeScript SDK

Status: accepted · Date: 2026-08-19

## Context

The old kit pinned `@modelcontextprotocol/sdk` 1.30.0 (published
2026-07-27), whose highest negotiable protocol version is `2025-11-25`, and
used `createMcpExpressApp` + a per-request `StreamableHTTPServerTransport`
with `sessionIdGenerator: undefined`.

Verified on 2026-08-19 against official sources:

* Spec: <https://modelcontextprotocol.io/specification/versioning> — current
  version is **2026-07-28**. That revision removes protocol-level sessions
  (`Mcp-Session-Id`), the standalone GET SSE stream, DELETE, `Last-Event-ID`
  resumability and the `initialize` handshake; every POST carries
  `MCP-Protocol-Version`, `Mcp-Method` (and `Mcp-Name` for `tools/call`) plus
  a `_meta` envelope; servers MUST validate `Origin` (403 if present and
  invalid), SHOULD bind localhost, SHOULD authenticate; unknown method → 404
  `-32601`; header/body mismatch → 400 `-32020`; unsupported version → 400
  `-32022`. Servers supporting only this revision SHOULD answer GET/DELETE
  with 405.
* SDK: <https://github.com/modelcontextprotocol/typescript-sdk> — v2.0.0
  (packages `@modelcontextprotocol/server`, `/node`, `/express`, `/core`,
  `/client`) is the stable line and implements 2026-07-28. `createMcpHandler(
  factory, { legacy: 'stateless' })` serves modern requests **and** answers
  2025-era `initialize`-style clients statelessly from the same tool
  registrations. The v1 transport class (`NodeStreamableHTTPServerTransport`)
  still exists but only speaks 2025-era versions and its
  `allowedHosts/allowedOrigins` options are deprecated in favour of external
  middleware. `LATEST_PROTOCOL_VERSION` in 2.0.0 is `"2025-11-25"` (latest
  *legacy* version); the modern list `["2026-07-28"]` is internal and visible
  via `server/discover`.

## Decision

* Depend on `@modelcontextprotocol/server@2.0.0` and
  `@modelcontextprotocol/node@2.0.0` (exact pins, lockfile committed) and
  `zod@4.4.3`. No Express: a small `node:http` pipeline applies Host, Origin,
  bearer and concurrency guards, then hands the request to
  `toNodeHandler(createMcpHandler(factory, { legacy: "stateless" }))`.
* Tools are registered inside the factory with `registerTool(name,
  { inputSchema: z.object(...), annotations }, cb)`; results carry both
  `content` (JSON text) and `structuredContent`; `view_image` returns an
  `image` content block.
* Compatibility policy: serve **2026-07-28** natively; keep serving
  2025-03-26 … 2025-11-25 clients statelessly (GET/DELETE → 405, no session
  IDs) for as long as the SDK v2 line does. Do not advertise the deprecated
  HTTP+SSE (2024-11-05) transport.
* Re-evaluate on each SDK minor release; protocol bumps are recorded here.

## Consequences

* Claude Code, Codex and other current clients (2025-era) work unchanged;
  clients that only speak 2026-07-28 also work.
* Elicitation/sampling/logging (deprecated in 2026-07-28) are not used.
* Tests exercise both eras through the real handler
  (`server/test/http.test.mjs`).
