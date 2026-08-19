# ADR-0006: Process groups and bounded termination

Status: accepted · Date: 2026-08-19

## Context

`write_stdin{terminate:true}` used `child.kill("SIGTERM")` on the direct
child only. Background grandchildren survived, SIGTERM-ignoring processes
lived forever, and server exit did not wait for anything.

## Decision

* Spawn every session with `detached: true` (setsid → own process group).
* `terminate()` sends SIGTERM to `-pid` (the group), starts a
  `MCPBOX_KILL_GRACE_MS` timer, then SIGKILL to the group if still alive.
* Sessions end on: client terminate, `MCPBOX_MAX_RUNTIME_MS`,
  `MCPBOX_IDLE_TIMEOUT_MS` (no poll/write), server shutdown. The reason is
  reported as `terminated_by`.
* `MCPBOX_MAX_SESSIONS` caps running sessions; exceeding it is a tool error.
* SIGINT/SIGTERM to the server → terminate all groups, wait ≤ grace+2 s, exit.
* `tini` is PID 1 in the container to reap re-parented processes.
* Output is decoded with `StringDecoder` per stream so multi-byte UTF-8 split
  across chunks is not corrupted.

## Consequences

Tests in `server/test/process-manager.test.mjs` verify grandchild death,
SIGKILL escalation, limits and shutdown; the Docker integration test checks
that no stray processes remain in the container after termination.
