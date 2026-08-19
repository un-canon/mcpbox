// MCP server factory: registers the four tools on a fresh McpServer. The
// factory is invoked once per HTTP request by createMcpHandler (stateless), so
// it must be cheap and must not hold per-instance state — sessions live in the
// shared ProcessManager passed in.

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createExecTools, createPatchTool, createImageTool, ToolError } from "./tools.mjs";

const require = createRequire(import.meta.url);
export const PACKAGE = require("../package.json");
export const SERVER_NAME = "mcpbox";
export const SERVER_VERSION = PACKAGE.version;

function jsonResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

function errorResult(error) {
  // Only ToolError messages are meant for the client verbatim; anything else
  // could carry paths or environment details.
  const message = error instanceof ToolError ? error.message : `Internal error (${error?.code || error?.name || "unknown"})`;
  return jsonResult({ error: message }, true);
}

/**
 * @param {object} deps
 * @param {import("./process-manager.mjs").ProcessManager} deps.processes
 * @param {ReturnType<import("./config.mjs").loadConfig>} deps.config
 */
export function createServerFactory({ processes, config }) {
  const exec = createExecTools({ processes, config });
  const patch = createPatchTool({ config });
  const image = createImageTool({ config });
  const cwd = config.workdir;
  const maxResult = config.maxResultChars;

  const instructions = [
    `You are connected to MCPBox, a persistent Debian development container. The default working directory is ${cwd}.`,
    "Use exec_command for shell work (it returns a session_id when the command is still running), write_stdin to poll, feed input to or terminate that session, apply_patch for unified-diff edits, and view_image to look at PNG/JPEG/WebP/GIF files.",
    "The container is the permission boundary: commands may use the full container including git, network access, package managers and passwordless sudo. Software installed with apt lives only in this container; the SSH workbench shares /workspace but not packages or processes.",
    "No deployment, cloud or GitHub push credentials are present unless the operator mounted them deliberately.",
    `Limits: at most ${config.maxSessions} concurrently running sessions, ${Math.round(config.maxRuntimeMs / 60000)} min max runtime per session, sessions idle for ${Math.round(config.idleTimeoutMs / 60000)} min are terminated.`
  ].join(" ");

  return function factory() {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });

    server.registerTool("exec_command", {
      title: "Execute shell command",
      description: `Run an unrestricted Bash command (bash -lc) inside the MCPBox container. Default working directory ${cwd}; relative workdir values resolve from there. Waits up to yield_time_ms; if the command is still running you get status "running" and a session_id for write_stdin. Set tty=true only for programs that need a terminal.`,
      inputSchema: z.object({
        cmd: z.string().min(1).describe("Complete Bash command to execute"),
        workdir: z.string().optional().describe(`Absolute path or path relative to ${cwd}`),
        tty: z.boolean().default(false).describe("Allocate a pseudo-terminal (via util-linux script)"),
        yield_time_ms: z.number().int().min(0).max(30_000).default(10_000).describe("How long to wait for completion before returning a session"),
        max_output_chars: z.number().int().min(1_000).max(maxResult).default(20_000)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    }, async input => {
      try {
        return jsonResult(await exec.execCommand(input));
      } catch (error) {
        return errorResult(error);
      }
    });

    server.registerTool("write_stdin", {
      title: "Continue shell session",
      description: "Poll a running exec_command session, send it exact stdin characters (include \\n to submit a line), or terminate it (SIGTERM to the whole process group, SIGKILL after a grace period). Empty chars just polls. Output returned is only what was not yet read.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        chars: z.string().default(""),
        terminate: z.boolean().default(false),
        yield_time_ms: z.number().int().min(0).max(30_000).optional().describe("Defaults to 250 ms after writing, 5000 ms when only polling"),
        max_output_chars: z.number().int().min(1_000).max(maxResult).default(20_000)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    }, async input => {
      try {
        return jsonResult(await exec.writeStdin(input));
      } catch (error) {
        return errorResult(error);
      }
    });

    server.registerTool("apply_patch", {
      title: "Apply unified diff",
      description: `Apply a standard unified diff with git apply in the requested directory (default ${cwd}). The patch is checked first (git apply --check) and only applied if it applies cleanly. Works outside Git repositories too, but then reports no diffstat. This is an editing convenience; exec_command remains unrestricted.`,
      inputSchema: z.object({
        patch: z.string().min(1).describe("Standard unified diff (--- a/… +++ b/… hunks)"),
        workdir: z.string().optional().describe(`Directory to apply in; defaults to ${cwd}`)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    }, async input => {
      try {
        return jsonResult(await patch.applyPatch(input));
      } catch (error) {
        return errorResult(error);
      }
    });

    server.registerTool("view_image", {
      title: "View local image",
      description: `Return a PNG, JPEG, WebP or GIF from the container to the client as an image content block. The format is detected from the file contents, not the extension. Files above ${config.maxImageBytes} bytes are rejected; resize or convert them with exec_command first.`,
      inputSchema: z.object({
        path: z.string().min(1).describe(`Absolute path or path relative to ${cwd}`)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    }, async input => {
      try {
        const result = await image.viewImage(input);
        return {
          content: [
            { type: "image", data: result.base64, mimeType: result.mimeType },
            { type: "text", text: JSON.stringify({ path: result.path, bytes: result.bytes, mimeType: result.mimeType }) }
          ]
        };
      } catch (error) {
        return errorResult(error);
      }
    });

    return server;
  };
}
