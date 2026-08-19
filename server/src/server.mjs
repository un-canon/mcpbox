#!/usr/bin/env node
// MCPBox MCP server entrypoint.
import { loadConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { loadTokenFromFile, TokenError } from "./token.mjs";
import { ProcessManager } from "./process-manager.mjs";
import { createServerFactory, SERVER_VERSION } from "./mcp.mjs";
import { createApp } from "./http.mjs";

const config = loadConfig();
const log = createLogger(config.logLevel);

let token;
try {
  token = loadTokenFromFile(config.tokenFile);
} catch (error) {
  if (error instanceof TokenError) {
    log.error(`token error: ${error.message}. Generate one with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' > runtime/mcpbox-token`);
    process.exit(78); // EX_CONFIG
  }
  throw error;
}

const processes = new ProcessManager({
  maxSessions: config.maxSessions,
  maxRuntimeMs: config.maxRuntimeMs,
  idleTimeoutMs: config.idleTimeoutMs,
  killGraceMs: config.killGraceMs,
  maxBufferChars: config.maxBufferChars,
  finishedRetentionMs: config.finishedRetentionMs,
  log: message => log.info(message)
});

const factory = createServerFactory({ processes, config });
const app = createApp({ factory, token, config, log });

app.server.listen(config.port, config.bindHost, () => {
  log.info("mcpbox listening", {
    version: SERVER_VERSION,
    bind: `${config.bindHost}:${config.port}`,
    path: config.mcpPath,
    legacyPathToken: config.legacyPathToken,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    limits: {
      maxSessions: config.maxSessions,
      maxRuntimeMs: config.maxRuntimeMs,
      idleTimeoutMs: config.idleTimeoutMs,
      maxConcurrentRequests: config.maxConcurrentRequests
    }
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  const forceExit = setTimeout(() => process.exit(1), config.killGraceMs + 5000);
  forceExit.unref();
  try {
    await Promise.allSettled([processes.shutdown(), app.close()]);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
