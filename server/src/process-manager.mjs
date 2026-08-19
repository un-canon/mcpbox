// Long-running command sessions for exec_command / write_stdin.
//
// Every session is spawned in its own process group (detached: true => setsid)
// so that termination can address the whole tree: SIGTERM to the group, a
// bounded grace period, then SIGKILL to the group. Sessions are bounded by a
// hard runtime limit, an idle timeout (no poll/write from the client), a cap on
// concurrently running sessions, and a per-session unread output buffer.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export class SessionLimitError extends Error {
  constructor(max) {
    super(`Too many running sessions (limit ${max}); terminate one with write_stdin first`);
    this.name = "SessionLimitError";
  }
}

const noop = () => {};

export class ProcessManager {
  /**
   * @param {object} options
   * @param {number} options.maxSessions
   * @param {number} options.maxRuntimeMs
   * @param {number} options.idleTimeoutMs
   * @param {number} options.killGraceMs
   * @param {number} options.maxBufferChars
   * @param {number} [options.finishedRetentionMs]
   * @param {(msg: string) => void} [options.log]
   * @param {string} [options.shell]
   * @param {string} [options.scriptBinary]
   */
  constructor(options) {
    this.maxSessions = options.maxSessions;
    this.maxRuntimeMs = options.maxRuntimeMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.killGraceMs = options.killGraceMs;
    this.maxBufferChars = options.maxBufferChars;
    this.finishedRetentionMs = options.finishedRetentionMs ?? 60 * 60 * 1000;
    this.log = options.log ?? noop;
    this.shell = options.shell ?? "/bin/bash";
    this.scriptBinary = options.scriptBinary ?? "/usr/bin/script";
    this.env = options.env ?? process.env;
    this.sessions = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  runningCount() {
    let count = 0;
    for (const s of this.sessions.values()) if (s.endedAt === null) count += 1;
    return count;
  }

  get(id) {
    return this.sessions.get(id);
  }

  start({ cmd, cwd, tty = false }) {
    if (this.runningCount() >= this.maxSessions) throw new SessionLimitError(this.maxSessions);
    const id = randomBytes(12).toString("hex");
    const spawnOptions = {
      cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true // own process group / session (setsid on POSIX)
    };
    const child = tty
      ? spawn(this.scriptBinary, ["-qefc", cmd, "/dev/null"], spawnOptions)
      : spawn(this.shell, ["-lc", cmd], spawnOptions);

    const state = {
      id,
      child,
      pid: child.pid ?? null,
      cmd,
      cwd,
      tty,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      terminatedBy: null, // "client" | "runtime_limit" | "idle_timeout" | "shutdown"
      unread: "",
      droppedChars: 0,
      waiters: [],
      decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
      timers: { runtime: null, idle: null, kill: null, cleanup: null }
    };

    child.stdout.on("data", chunk => this.#append(state, state.decoders.stdout.write(chunk)));
    child.stderr.on("data", chunk => this.#append(state, state.decoders.stderr.write(chunk)));
    child.stdin.on("error", () => {}); // EPIPE after the process exits
    child.on("error", error => this.#append(state, `\n[process error] ${error.message}\n`));
    child.on("close", (code, signal) => {
      this.#append(state, state.decoders.stdout.end() + state.decoders.stderr.end());
      state.exitCode = code;
      state.signal = signal;
      state.endedAt = Date.now();
      this.#clearTimer(state, "runtime");
      this.#clearTimer(state, "idle");
      this.#clearTimer(state, "kill");
      for (const waiter of [...state.waiters]) waiter.finish();
      this.#scheduleCleanup(state);
    });

    state.timers.runtime = setTimeout(() => {
      this.log(`session ${id} exceeded max runtime; terminating`);
      this.terminate(state, "runtime_limit");
    }, this.maxRuntimeMs);
    state.timers.runtime.unref();
    this.#armIdle(state);

    this.sessions.set(id, state);
    return state;
  }

  /** Mark client activity (poll / write). */
  touch(state) {
    state.lastTouchedAt = Date.now();
    if (state.endedAt === null) this.#armIdle(state);
  }

  write(state, chars) {
    if (state.endedAt !== null) return false;
    this.touch(state);
    state.child.stdin.write(chars);
    return true;
  }

  /**
   * SIGTERM the process group, then SIGKILL after killGraceMs if it is still
   * alive. Idempotent.
   */
  terminate(state, reason = "client") {
    if (state.endedAt !== null) return;
    if (state.terminatedBy === null) state.terminatedBy = reason;
    this.#signalGroup(state, "SIGTERM");
    if (!state.timers.kill) {
      state.timers.kill = setTimeout(() => {
        state.timers.kill = null;
        if (state.endedAt === null) {
          this.log(`session ${state.id} ignored SIGTERM; sending SIGKILL to group`);
          this.#signalGroup(state, "SIGKILL");
        }
      }, this.killGraceMs);
      state.timers.kill.unref();
    }
  }

  /** Resolve when the process has ended, produced output (optionally), or after ms. */
  wait(state, milliseconds, returnOnOutput = false) {
    if (state.endedAt !== null || (returnOnOutput && state.unread)) return Promise.resolve();
    return new Promise(resolveWait => {
      let done = false;
      const waiter = {
        returnOnOutput,
        finish: () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          resolveWait();
        }
      };
      const timer = setTimeout(waiter.finish, milliseconds);
      state.waiters.push(waiter);
    });
  }

  /** Take up to maxChars of unread output and return a status snapshot. */
  consume(state, maxChars) {
    const output = state.unread.slice(0, maxChars);
    state.unread = state.unread.slice(output.length);
    const result = {
      status: state.endedAt === null ? "running" : "completed",
      session_id: state.endedAt === null || state.unread ? state.id : null,
      output,
      output_truncated: state.unread.length > 0,
      dropped_chars: state.droppedChars,
      exit_code: state.exitCode,
      signal: state.signal,
      terminated_by: state.terminatedBy,
      cwd: state.cwd,
      wall_time_ms: (state.endedAt || Date.now()) - state.startedAt
    };
    state.droppedChars = 0;
    if (state.endedAt !== null && !state.unread) {
      this.#clearTimer(state, "cleanup");
      this.#scheduleCleanup(state, 60_000);
    }
    return result;
  }

  /** Terminate every running session and wait (bounded) for them to exit. */
  async shutdown() {
    clearInterval(this.sweeper);
    const running = [...this.sessions.values()].filter(s => s.endedAt === null);
    for (const state of running) this.terminate(state, "shutdown");
    const deadline = Date.now() + this.killGraceMs + 2000;
    while (running.some(s => s.endedAt === null) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    for (const state of running) {
      if (state.endedAt === null) this.#signalGroup(state, "SIGKILL");
    }
    for (const state of this.sessions.values()) {
      for (const key of Object.keys(state.timers)) this.#clearTimer(state, key);
    }
    this.sessions.clear();
  }

  /** Drop finished sessions older than finishedRetentionMs. */
  sweep() {
    const cutoff = Date.now() - this.finishedRetentionMs;
    for (const [id, state] of this.sessions) {
      if (state.endedAt !== null && state.endedAt < cutoff) {
        this.#clearTimer(state, "cleanup");
        this.sessions.delete(id);
      }
    }
  }

  // --- internals -----------------------------------------------------------

  #append(state, text) {
    if (!text) return;
    state.unread += text;
    if (state.unread.length > this.maxBufferChars) {
      const excess = state.unread.length - this.maxBufferChars;
      state.unread = state.unread.slice(excess);
      state.droppedChars += excess;
    }
    for (const waiter of [...state.waiters]) {
      if (waiter.returnOnOutput) waiter.finish();
    }
  }

  #armIdle(state) {
    this.#clearTimer(state, "idle");
    state.timers.idle = setTimeout(() => {
      this.log(`session ${state.id} idle for ${this.idleTimeoutMs} ms; terminating`);
      this.terminate(state, "idle_timeout");
    }, this.idleTimeoutMs);
    state.timers.idle.unref();
  }

  #signalGroup(state, signal) {
    if (!state.pid) return;
    try {
      process.kill(-state.pid, signal); // whole process group
    } catch (error) {
      if (error.code === "ESRCH") return;
      try {
        state.child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  #clearTimer(state, key) {
    if (state.timers[key]) {
      clearTimeout(state.timers[key]);
      state.timers[key] = null;
    }
  }

  #scheduleCleanup(state, delay = this.finishedRetentionMs) {
    if (state.timers.cleanup) return;
    state.timers.cleanup = setTimeout(() => {
      state.timers.cleanup = null;
      if (state.endedAt !== null && !state.unread) this.sessions.delete(state.id);
    }, delay);
    state.timers.cleanup.unref();
  }
}
