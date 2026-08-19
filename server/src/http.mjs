// HTTP request pipeline (plain node:http, no framework):
//
//   /healthz                 -> 200 "ok" (no auth; used by Compose healthcheck)
//   POST /mcp                -> Host check -> Origin check -> Bearer auth ->
//                               concurrency gate -> MCP handler (createMcpHandler)
//   POST /<token>/mcp        -> same, only when MCPBOX_LEGACY_PATH_TOKEN=1 (deprecated)
//   GET/DELETE /mcp          -> handled by the SDK (405 for legacy clients)
//   anything else            -> 404
//
// The MCP handler is the SDK v2 stateless entry: it serves the 2026-07-28
// protocol and falls back to stateless 2025-era serving. It performs no Host,
// Origin or token validation itself — that is done here, before it runs.

import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { checkAuth, checkHost, checkOrigin } from "./auth.mjs";

const MAX_BODY_BYTES = 8 * 1024 * 1024; // patches can be large; images are never uploaded

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

function rpcError(res, status, message, extraHeaders = {}) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, extraHeaders);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {object} deps
 * @param {() => import("@modelcontextprotocol/server").McpServer} deps.factory
 * @param {string} deps.token
 * @param {ReturnType<import("./config.mjs").loadConfig>} deps.config
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} deps.log
 */
export function createApp({ factory, token, config, log }) {
  const mcp = createMcpHandler(factory, {
    legacy: "stateless",
    onerror: error => log.error("mcp handler error", { message: error?.message })
  });
  const mcpNode = toNodeHandler(mcp, { onerror: error => log.error("mcp transport error", { message: error?.message }) });

  const legacyPathRe = /^\/([A-Za-z0-9._~+/=-]{32,512})\/mcp\/?$/;
  let inFlight = 0;

  async function handle(req, res) {
    const url = new URL(req.url, "http://placeholder");
    const path = url.pathname;

    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("ok\n");
      return;
    }

    // Determine whether this is the MCP endpoint (fixed path or legacy token path).
    let pathToken = null;
    if (path !== config.mcpPath && path !== `${config.mcpPath}/`) {
      const legacy = legacyPathRe.exec(path);
      if (legacy && !legacy[1].includes("/")) pathToken = legacy[1];
      if (pathToken === null) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found\n");
        return;
      }
    }

    // 1. Host, 2. Origin (DNS-rebinding), 3. bearer auth.
    const hostRejection = checkHost(req.headers, config.allowedHosts);
    if (hostRejection) {
      log.warn("rejected request: host", { status: hostRejection.status });
      return rpcError(res, hostRejection.status, hostRejection.error);
    }
    const originRejection = checkOrigin(req.headers, config.allowedHosts, config.allowedOrigins);
    if (originRejection) {
      log.warn("rejected request: origin", { status: originRejection.status });
      return rpcError(res, originRejection.status, originRejection.error);
    }
    const authRejection = checkAuth({ headers: req.headers, pathToken }, { token, legacyPathToken: config.legacyPathToken });
    if (authRejection) {
      log.warn("rejected request: auth", { status: authRejection.status, legacyPath: pathToken !== null });
      const headers = authRejection.status === 401 ? { "www-authenticate": 'Bearer realm="mcpbox"' } : {};
      return rpcError(res, authRejection.status, authRejection.error, headers);
    }
    if (pathToken !== null) {
      log.warn("deprecated legacy path-token request accepted; switch the client to Authorization: Bearer at /mcp");
    }

    if (inFlight >= config.maxConcurrentRequests) {
      return rpcError(res, 503, "Server busy; retry shortly", { "retry-after": "1" });
    }
    inFlight += 1;
    res.on("close", () => { inFlight -= 1; });

    // Parse the body ourselves so we can enforce a size limit; the SDK
    // accepts a pre-parsed body.
    let parsedBody;
    if (req.method === "POST") {
      let raw;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        // Answer, then drop the connection: the client may still be sending.
        res.on("finish", () => req.destroy());
        return rpcError(res, error.status || 400, error.status === 413 ? "Payload too large" : "Bad request", { connection: "close" });
      }
      if (raw.length > 0) {
        try {
          parsedBody = JSON.parse(raw.toString("utf8"));
        } catch {
          return rpcError(res, 400, "Body is not valid JSON");
        }
      }
    }
    // Present the request to the SDK at the canonical path so legacy-path
    // clients are indistinguishable from /mcp clients from here on.
    req.url = config.mcpPath + url.search;
    await mcpNode(req, res, parsedBody);
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch(error => {
      log.error("request failed", { message: error?.message });
      if (!res.headersSent) rpcError(res, 500, "Internal server error");
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // long polls (yield_time_ms up to 30 s) + SSE keep-alives
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  return {
    server,
    mcp,
    async close() {
      await mcp.close();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}
