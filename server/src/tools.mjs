// Tool implementations, independent of the MCP transport so they can be unit
// tested directly. Each handler returns a plain object; mcp.mjs wraps it in
// MCP content.

import { spawn } from "node:child_process";
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SessionLimitError } from "./process-manager.mjs";

export class ToolError extends Error {}

export function clamp(value, min, max, fallback) {
  const number = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, number));
}

export function resolveWorkdir(defaultCwd, path) {
  const candidate = path ? (isAbsolute(path) ? path : resolve(defaultCwd, path)) : defaultCwd;
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new ToolError(`Working directory does not exist: ${candidate}`);
  }
  return candidate;
}

export function runCapture(command, args, { cwd, input, env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout: Buffer.concat(stdout), stderr: Buffer.from("command timed out"), timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => finish({ code: null, stdout: Buffer.concat(stdout), stderr: Buffer.from(error.message) }));
    child.on("close", code => finish({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// --- exec_command / write_stdin ------------------------------------------------

export function createExecTools({ processes, config }) {
  const maxResult = config.maxResultChars;

  async function execCommand(input) {
    const cwd = resolveWorkdir(config.workdir, input.workdir);
    let state;
    try {
      state = processes.start({ cmd: input.cmd, cwd, tty: Boolean(input.tty) });
    } catch (error) {
      if (error instanceof SessionLimitError) throw new ToolError(error.message);
      throw error;
    }
    const yieldMs = clamp(input.yield_time_ms, 0, 30_000, 10_000);
    await processes.wait(state, yieldMs, false);
    return processes.consume(state, clamp(input.max_output_chars, 1_000, maxResult, 20_000));
  }

  async function writeStdin(input) {
    const state = processes.get(input.session_id);
    if (!state) throw new ToolError("Unknown or expired session");
    processes.touch(state);
    if (input.terminate) processes.terminate(state, "client");
    if (input.chars) processes.write(state, input.chars);
    const wait = clamp(input.yield_time_ms, 0, 30_000, input.chars ? 250 : 5_000);
    await processes.wait(state, wait, true);
    return processes.consume(state, clamp(input.max_output_chars, 1_000, maxResult, 20_000));
  }

  return { execCommand, writeStdin };
}

// --- apply_patch ---------------------------------------------------------------

export function createPatchTool({ config }) {
  async function applyPatch(input) {
    const cwd = resolveWorkdir(config.workdir, input.workdir);
    const inside = await runCapture("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    const isGitRepo = inside.code === 0 && inside.stdout.toString("utf8").trim() === "true";

    // Outside a repository `git apply` still works but reports nothing useful
    // afterwards; make that explicit so callers are not surprised.
    const commonArgs = ["apply", "--recount", "--whitespace=nowarn"];
    const check = await runCapture("git", [...commonArgs, "--check", "-"], { cwd, input: input.patch });
    if (check.code !== 0) {
      throw new ToolError(`Patch does not apply cleanly:\n${(check.stderr.toString("utf8") || check.stdout.toString("utf8")).trim()}`);
    }
    const applied = await runCapture("git", [...commonArgs, "-"], { cwd, input: input.patch });
    if (applied.code !== 0) {
      throw new ToolError(`git apply failed after a successful check:\n${(applied.stderr.toString("utf8") || applied.stdout.toString("utf8")).trim()}`);
    }

    // Which files did the patch mention? Parse "+++ b/<path>" and
    // "--- a/<path>" lines so new (untracked) files are reported too.
    const files = new Set();
    for (const line of input.patch.split(/\r?\n/)) {
      const m = /^(?:\+\+\+|---) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line);
      if (m && m[1] !== "/dev/null") files.add(m[1]);
    }

    const result = { applied: true, git_repository: isGitRepo, files: [...files].sort() };
    if (isGitRepo) {
      const stat = await runCapture("git", ["diff", "--stat", "--"], { cwd });
      const untracked = await runCapture("git", ["ls-files", "--others", "--exclude-standard", "--", ...result.files], { cwd });
      result.diffstat = stat.code === 0 ? stat.stdout.toString("utf8") : null;
      result.new_untracked_files = untracked.code === 0
        ? untracked.stdout.toString("utf8").split("\n").filter(Boolean)
        : [];
    } else {
      result.note = "Directory is not inside a Git work tree; the patch was applied to plain files and no diffstat is available.";
    }
    return result;
  }
  return { applyPatch };
}

// --- view_image ---------------------------------------------------------------

const SIGNATURES = [
  { mime: "image/png", test: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", test: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: b => b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a") },
  { mime: "image/webp", test: b => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" }
];

export function sniffImageMime(buffer) {
  for (const sig of SIGNATURES) if (sig.test(buffer)) return sig.mime;
  return null;
}

export function createImageTool({ config }) {
  async function viewImage(input) {
    const path = isAbsolute(input.path) ? input.path : resolve(config.workdir, input.path);
    if (!existsSync(path) || !statSync(path).isFile()) throw new ToolError(`Image does not exist: ${path}`);
    const size = statSync(path).size;
    if (size > config.maxImageBytes) {
      throw new ToolError(`Image is ${size} bytes; limit is ${config.maxImageBytes}. Resize or convert it with exec_command first.`);
    }
    // Sniff before reading the whole file.
    const head = Buffer.alloc(16);
    const fd = openSync(path, "r");
    let read = 0;
    try {
      read = readSync(fd, head, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    const mimeType = sniffImageMime(head.subarray(0, read));
    if (!mimeType) throw new ToolError("Unsupported or unrecognised image format (expected PNG, JPEG, WebP or GIF by content)");
    const data = readFileSync(path);
    return { path, bytes: data.length, mimeType, base64: data.toString("base64") };
  }
  return { viewImage };
}
