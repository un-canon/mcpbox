# ADR-0005: Default resource limits

Status: accepted · Date: 2026-08-19

## Context

The old kit had no CPU, memory, PID, fd, session-count, runtime or request
limits; a confused agent could fork-bomb the host or fill RAM.

## Decision

Compose (`.env` overridable): `cpus 2`, `mem_limit 4g` (+ `memswap_limit`
equal, i.e. no extra swap), `pids_limit 1024` (mcp) / `2048` (workbench),
`nofile 65536`.

Server: max 16 running sessions, 1 h max runtime, 30 min idle timeout, 5 s
kill grace, 2 M chars unread buffer, 100 k chars per result, 12 MiB images,
32 in-flight HTTP requests.

Rationale: 2 CPU / 4 GiB lets `npm ci`, `pip install`, Go/TS builds and modest
C builds work on a laptop while bounding damage; PID limits are the cheapest
fork-bomb defence; idle timeout reclaims sessions abandoned by a client that
disconnected.

Not enforced by default (documented as risk): disk quota on the workspace
volume, network egress filtering.

## Consequences

Heavy compilation needs `.env` tuning; documented in `docs/configuration.md`.
