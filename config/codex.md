# Codex

Codex reads HTTP MCP servers from `~/.codex/config.toml` and takes the bearer
token from an environment variable, so the secret never sits in the config
file:

```toml
[mcp_servers.mcpbox]
url = "http://127.0.0.1:33333/mcp"
bearer_token_env_var = "MCPBOX_TOKEN"
```

Export the token in the shell that launches Codex (or in your shell profile):

```bash
export MCPBOX_TOKEN="$(cat /path/to/mcpbox/runtime/mcpbox-token)"
codex mcp list
```
