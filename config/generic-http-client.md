# Any Streamable HTTP MCP client

* Endpoint: `http://127.0.0.1:33333/mcp` (POST)
* Header: `Authorization: Bearer <contents of runtime/mcpbox-token>`
* Also send `Accept: application/json, text/event-stream` and
  `Content-Type: application/json`.
* Protocol: MCP 2026-07-28 (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`
  headers) or a 2025-era `initialize` handshake; both are served statelessly.
  `GET`/`DELETE` return 405.

Smoke test:

```bash
TOKEN="$(cat runtime/mcpbox-token)"
curl -s -X POST http://127.0.0.1:33333/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```
