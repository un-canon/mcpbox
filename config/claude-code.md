# Claude Code

Add MCPBox as a user-scoped HTTP MCP server (run from the mcpbox directory so
`runtime/mcpbox-token` resolves):

```bash
claude mcp add --transport http --scope user mcpbox http://127.0.0.1:33333/mcp \
  --header "Authorization: Bearer $(cat runtime/mcpbox-token)"
```

Verify / remove:

```bash
claude mcp get mcpbox
claude mcp remove mcpbox --scope user
```

If you rotate the token, remove and re-add the server. Never commit the
resulting `~/.claude.json` entry or paste the token into a project `.mcp.json`
that is checked in.
