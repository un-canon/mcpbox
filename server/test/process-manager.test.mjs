// Process lifecycle tests. These need a POSIX shell (/bin/bash) and process
// groups, so they are skipped on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { ProcessManager, SessionLimitError } from "../src/process-manager.mjs";

const posix = process.platform !== "win32";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function manager(overrides = {}) {
  return new ProcessManager({
    maxSessions: 4,
    maxRuntimeMs: 60_000,
    idleTimeoutMs: 60_000,
    killGraceMs: 500,
    maxBufferChars: 10_000,
    finishedRetentionMs: 60_000,
    ...overrides
  });
}

test("simple command completes and returns output/exit code", { skip: !posix }, async () => {
  const pm = manager();
  const s = pm.start({ cmd: "printf 'hello\\n'; exit 3", cwd: "/tmp" });
  await pm.wait(s, 5000);
  const r = pm.consume(s, 1000);
  assert.equal(r.status, "completed");
  assert.equal(r.exit_code, 3);
  assert.equal(r.output, "hello\n");
  assert.equal(r.session_id, null);
  await pm.shutdown();
});

test("multi-byte UTF-8 split across chunks is decoded correctly", { skip: !posix }, async () => {
  const pm = manager();
  // Emit a 3-byte character with each byte in a separate write, sleeping in between
  // so they arrive as separate chunks. "中" = E4 B8 AD.
  const s = pm.start({ cmd: "printf '\\xe4'; sleep 0.2; printf '\\xb8'; sleep 0.2; printf '\\xad\\n'", cwd: "/tmp" });
  await pm.wait(s, 5000);
  const r = pm.consume(s, 1000);
  assert.equal(r.output, "中\n");
  await pm.shutdown();
});

test("terminate kills the whole process group, escalating to SIGKILL", { skip: !posix }, async () => {
  const pm = manager({ killGraceMs: 300 });
  // A parent that ignores SIGTERM and a background grandchild that also ignores it.
  const s = pm.start({
    cmd: "trap '' TERM; (trap '' TERM; sleep 300) & echo $! > /tmp/mcpbox-grandchild.$$; echo started; sleep 300",
    cwd: "/tmp"
  });
  await pm.wait(s, 5000, true);
  assert.equal(pm.runningCount(), 1);
  const gcFile = execSync("ls /tmp/mcpbox-grandchild.* | head -1").toString().trim();
  const grandchild = Number(execSync(`cat ${gcFile}`).toString().trim());
  assert.ok(pidAlive(grandchild), "grandchild should be running");
  pm.terminate(s, "client");
  await pm.wait(s, 5000);
  const r = pm.consume(s, 1000);
  assert.equal(r.status, "completed");
  assert.equal(r.signal, "SIGKILL");
  assert.equal(r.terminated_by, "client");
  // Give the kernel a moment to reap the grandchild after the group SIGKILL.
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pidAlive(grandchild), false, "grandchild should be dead");
  execSync(`rm -f ${gcFile}`);
  await pm.shutdown();
});

test("write_stdin reaches the process", { skip: !posix }, async () => {
  const pm = manager();
  const s = pm.start({ cmd: "read line; echo got:$line", cwd: "/tmp" });
  pm.write(s, "abc\n");
  await pm.wait(s, 5000);
  assert.equal(pm.consume(s, 1000).output, "got:abc\n");
  await pm.shutdown();
});

test("session limit is enforced", { skip: !posix }, async () => {
  const pm = manager({ maxSessions: 2 });
  const a = pm.start({ cmd: "sleep 30", cwd: "/tmp" });
  const b = pm.start({ cmd: "sleep 30", cwd: "/tmp" });
  assert.throws(() => pm.start({ cmd: "sleep 30", cwd: "/tmp" }), SessionLimitError);
  pm.terminate(a);
  await pm.wait(a, 5000);
  const c = pm.start({ cmd: "echo ok", cwd: "/tmp" });
  await pm.wait(c, 5000);
  pm.terminate(b);
  await pm.shutdown();
});

test("runtime limit terminates a session", { skip: !posix }, async () => {
  const pm = manager({ maxRuntimeMs: 1000, killGraceMs: 200 });
  const s = pm.start({ cmd: "sleep 30", cwd: "/tmp" });
  await pm.wait(s, 5000);
  const r = pm.consume(s, 100);
  assert.equal(r.status, "completed");
  assert.equal(r.terminated_by, "runtime_limit");
  await pm.shutdown();
});

test("idle timeout terminates a session nobody polls", { skip: !posix }, async () => {
  const pm = manager({ idleTimeoutMs: 1000, killGraceMs: 200 });
  const s = pm.start({ cmd: "sleep 30", cwd: "/tmp" });
  await new Promise(r => setTimeout(r, 2500));
  const r = pm.consume(s, 100);
  assert.equal(r.status, "completed");
  assert.equal(r.terminated_by, "idle_timeout");
  await pm.shutdown();
});

test("output buffer is capped and dropped chars are counted", { skip: !posix }, async () => {
  const pm = manager({ maxBufferChars: 10_000 });
  const s = pm.start({ cmd: "head -c 30000 /dev/zero | tr '\\0' 'x'", cwd: "/tmp" });
  await pm.wait(s, 5000);
  const r = pm.consume(s, 100_000);
  assert.equal(r.output.length, 10_000);
  assert.equal(r.dropped_chars, 20_000);
  await pm.shutdown();
});

test("shutdown terminates every running session", { skip: !posix }, async () => {
  const pm = manager({ killGraceMs: 200 });
  const a = pm.start({ cmd: "trap '' TERM; sleep 300", cwd: "/tmp" });
  const b = pm.start({ cmd: "sleep 300", cwd: "/tmp" });
  const pids = [a.pid, b.pid];
  await pm.shutdown();
  await new Promise(r => setTimeout(r, 200));
  for (const pid of pids) assert.equal(pidAlive(pid), false);
  assert.equal(pm.sessions.size, 0);
});
