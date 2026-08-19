# Release checklist

Before tagging `vX.Y.Z`:

- [ ] **Licence chosen and committed** (`LICENSE`, `server/package.json`
      `license`) — see ADR-0007. Blocking for the first public release.
- [ ] `server/package.json` version bumped; `CHANGELOG.md` section dated.
- [ ] `cd server && npm ci && npm test` green on Linux.
- [ ] `tests/integration/test-token-permissions.sh` green on a Linux host.
- [ ] `tests/integration/test-compose.sh` green.
- [ ] `shellcheck setup.sh docker/*.sh tests/integration/*.sh scripts/*.sh`
      and `hadolint docker/Dockerfile` clean.
- [ ] `scripts/secret-scan.sh` clean; `git status` shows no `.env`, `runtime/`,
      keys or tokens.
- [ ] README quick start executed verbatim on a clean checkout.
- [ ] `docs/security-model.md` still matches the code (limits, auth, mounts).
- [ ] Tag: `git tag -a vX.Y.Z -m "MCPBox vX.Y.Z" && git push origin vX.Y.Z`
      (never force-push).
- [ ] GitHub release notes = CHANGELOG section; mention the compatible
      `mcpbox-skill` version.
- [ ] Update `mcpbox-skill/references/compatibility.md` if configuration
      keys, ports, tool names or auth changed.
