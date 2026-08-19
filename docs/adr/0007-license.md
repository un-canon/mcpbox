# ADR-0007: Licence — release blocker

Status: open · Date: 2026-08-19

## Context

`ssh-mcp-four-tools-kit..zip` (SHA-256
`cc7c27c5acb3e76db4df8c0ec66a5948cf9250cc6985d3ac4f83e65bc8708d54`) contains
no `LICENSE`, no `license` field in `package.json` and no copyright notice.
Under default copyright, "no licence" means "all rights reserved".

## Decision

Do **not** invent a licence. `mcpbox` and `mcpbox-skill` are new works derived
from the kit's design; the substantial rewrite in this repository is by the
`un-canon` account. Before the first public release the repository owner must
choose and add a licence (`LICENSE` at the repo root, `license` in
`server/package.json`, matching SPDX identifier in the skill's `README`).

## Status

**Blocking for a public v1.0.0 release** — tracked in `RELEASE_CHECKLIST.md`.
Until a licence is added the repositories may be pushed as source-available
with the default (all rights reserved) status but must not claim to be "open
source", and `package.json` carries `"license": "UNLICENSED"` to make that
explicit.
