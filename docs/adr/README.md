# Architecture Decision Records

| ID | Title | Status |
| --- | --- | --- |
| [0001](0001-split-runtime-and-skill.md) | Split the old kit into `mcpbox` (runtime) and `mcpbox-skill` (ChatGPT Skill) | accepted |
| [0002](0002-bearer-token-authentication.md) | Bearer token at a fixed `/mcp` path; legacy path token opt-in and deprecated | accepted |
| [0003](0003-mcp-protocol-and-sdk.md) | MCP protocol version and TypeScript SDK choice | accepted |
| [0004](0004-token-handoff-and-privilege-drop.md) | Root entrypoint copies the token and drops privileges (P0 fix) | accepted |
| [0005](0005-resource-limits.md) | Default resource limits | accepted |
| [0006](0006-process-lifecycle.md) | Process groups, SIGTERM→SIGKILL, session limits | accepted |
| [0007](0007-license.md) | No licence inherited from the source kit — release blocker | open |
| [0008](0008-host-and-origin-validation.md) | Host and Origin validation policy | accepted |
