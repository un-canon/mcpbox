# Security policy

## Supported versions

Only the latest minor release of MCPBox receives fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's
private vulnerability reporting on this repository
("Security" → "Report a vulnerability"), or contact the maintainer through the
GitHub profile of `un-canon`. Include the MCPBox version (`git describe` /
`server/package.json`), your Docker version and platform, and a reproduction.

You should get an acknowledgement within a week.

## Scope

In scope: anything that lets an MCP client or SSH user escape the container
boundary described in `docs/security-model.md`, bypass bearer authentication
or the Host/Origin checks, read the token from another container, or exhaust
host resources despite the default limits.

Out of scope by design (see the security model): the fact that `exec_command`
runs arbitrary commands with `sudo` *inside* the container, the shared
workspace between all clients of one instance, and any deployment that
publishes the MCP port to a non-loopback address.
