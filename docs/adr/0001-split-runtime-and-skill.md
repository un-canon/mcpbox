# ADR-0001: Split the old kit into `mcpbox` and `mcpbox-skill`

Status: accepted · Date: 2026-08-19

## Context

`ssh-mcp-four-tools-kit` was distributed as a zip that was sometimes described
as a "ChatGPT Skill". It has no `SKILL.md` or `agents/openai.yaml`; it is a
Docker Compose stack (Node MCP server + OpenSSH workbench). A Docker runtime
cannot become an in-ChatGPT tool by being placed inside a Skill archive.

## Decision

* `un-canon/mcpbox` — the runtime: images, Compose, MCP server, sshd, tests,
  security docs, releases. Semantic versioning, independent of the skill.
* `un-canon/mcpbox-skill` — a standard ChatGPT Skill (`mcpbox-operator`, UI
  name "MCPBox Operator") that helps a user deploy, secure, audit and operate
  a specific released version range of MCPBox. It contains reference docs,
  audit scripts and templates, never the runtime source. It declares a
  compatibility matrix against MCPBox releases.

## Consequences

* Two version streams; the skill's `references/compatibility.md` states which
  MCPBox versions it knows.
* Runtime security claims live in one place (`mcpbox/docs/security-model.md`)
  and the skill links to / summarises them rather than restating them.
