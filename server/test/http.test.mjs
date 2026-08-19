// End-to-end HTTP tests: boots the real server on an ephemeral port with a
// temporary token file and exercises host/origin/auth guards plus both MCP
// protocol eras (2026-07-28 "modern" and 2025-11-25 "legacy") through the
// SDK v2 handler.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";

const posix = process.platform !== "win32";
const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = "mcpbox-test-token-Q2xhdWRlLU1DUEJveC0yMDI2LTA4LTE5";
const MODERN = "2026-07-28";

async function freePort() {
  return new Promise(resolve => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let child;
let base;
let stderr = "";

async function startServer(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcpbox-http-"));
  writeFileSync(join(dir, "token"), `${TOKEN}\n`);
  const port = await freePort();
  child = spawn(process.execPath, [join(here, "..", "src", "server.mjs")], {
    env: {
      ...process.env,
      MCPBOX_PORT: String(port),
      MCPBOX_BIND: "127.0.0.1",
      MCPBOX_TOKEN_FILE: join(dir, "token"),
      MCPBOX_WORKDIR: dir,
      MCPBOX_LOG_LEVEL: "debug",
      MCPBOX_MAX_CONCURRENT_REQUESTS: "4",
      ...extraEnv
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", d => { stderr += d.toString(); });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`server did not start:\n${stderr}`);
}

function stopServer() {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref();
  });
}

const H = {
  json: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  auth: { authorization: `Bearer ${TOKEN}` }
};

function modernBody(id, method, params = {}) {
  return JSON.stringify({
    jsonrpc: "2.0", id, method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientInfo": { name: "mcpbox-test", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  });
}

async function modern(method, params, extraHeaders = {}) {
  const headers = { ...H.json, ...H.auth, "mcp-protocol-version": MODERN, "mcp-method": method, ...extraHeaders };
  if (method === "tools/call") headers["mcp-name"] = params.name;
  const r = await fetch(`${base}/mcp`, { method: "POST", headers, body: modernBody(1, method, params) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: r.status, headers: r.headers, text, json };
}

// fetch() forbids overriding Host, so use node:http for that case.
function rawPost(path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = httpRequest({ host: u.hostname, port: u.port, path, method: "POST", headers }, res => {
      let data = "";
      res.on("data", d => { data += d; });
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function legacyInit(extraHeaders = {}, path = "/mcp") {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...H.json, ...H.auth, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } })
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

before(async () => { await startServer(); });
after(async () => { await stopServer(); });

test("healthz is open and unauthenticated", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "ok\n");
});

test("unknown paths are 404 (including legacy token path when disabled)", async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const r = await fetch(`${base}/${TOKEN}/mcp`, { method: "POST", headers: H.json, body: modernBody(1, "tools/list") });
  assert.equal(r.status, 404);
});

test("missing / wrong bearer token -> 401 with WWW-Authenticate, generic body", async () => {
  const none = await fetch(`${base}/mcp`, { method: "POST", headers: H.json, body: modernBody(1, "tools/list") });
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate"), /Bearer/);
  const wrong = await fetch(`${base}/mcp`, { method: "POST", headers: { ...H.json, authorization: `Bearer ${TOKEN}x` }, body: modernBody(1, "tools/list") });
  assert.equal(wrong.status, 401);
  const body = await wrong.text();
  assert.ok(!body.includes(TOKEN));
});

test("bad Host -> 421, bad Origin -> 403, allowed Origin -> 200", async () => {
  const badHost = await rawPost("/mcp", { ...H.json, ...H.auth, host: "evil.example:1", "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }, modernBody(1, "tools/list"));
  assert.equal(badHost.status, 421);
  const okHost = await rawPost("/mcp", { ...H.json, ...H.auth, host: "localhost:1", "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }, modernBody(1, "tools/list"));
  assert.equal(okHost.status, 200);
  const badOrigin = await modern("tools/list", {}, { origin: "http://evil.example" });
  assert.equal(badOrigin.status, 403);
  const nullOrigin = await modern("tools/list", {}, { origin: "null" });
  assert.equal(nullOrigin.status, 403);
  const goodOrigin = await modern("tools/list", {}, { origin: "http://localhost:5173" });
  assert.equal(goodOrigin.status, 200);
});

test("modern (2026-07-28) server/discover and tools/list", async () => {
  const discover = await modern("server/discover");
  assert.equal(discover.status, 200);
  assert.deepEqual(discover.json.result.supportedVersions, [MODERN]);
  const list = await modern("tools/list");
  assert.equal(list.status, 200);
  const names = list.json.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ["apply_patch", "exec_command", "view_image", "write_stdin"]);
  const view = list.json.result.tools.find(t => t.name === "view_image");
  assert.ok(!("detail" in (view.inputSchema.properties || {})), "detail parameter must be gone");
  assert.equal(list.json.result._meta["io.modelcontextprotocol/serverInfo"].name, "mcpbox");
});

test("modern unsupported protocol version -> 400, GET/DELETE -> 405", async () => {
  const bad = await modern("tools/list", {}, { "mcp-protocol-version": "2030-01-01" });
  // Header/body mismatch or unsupported version are both 400 per spec.
  assert.equal(bad.status, 400);
  const get = await fetch(`${base}/mcp`, { headers: { ...H.auth, accept: "text/event-stream" } });
  assert.equal(get.status, 405);
  const del = await fetch(`${base}/mcp`, { method: "DELETE", headers: H.auth });
  assert.equal(del.status, 405);
});

test("legacy (2025-11-25) initialize works statelessly without a session id", async () => {
  const r = await legacyInit();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("mcp-session-id"), null);
  assert.match(r.text, /"protocolVersion":"2025-11-25"/);
  assert.match(r.text, /"name":"mcpbox"/);
});

test("exec_command round trip and write_stdin terminate via tools/call", { skip: !posix }, async () => {
  const echo = await modern("tools/call", { name: "exec_command", arguments: { cmd: "echo héllo wörld; exit 4" } });
  assert.equal(echo.status, 200, echo.text);
  const sc = echo.json.result.structuredContent;
  assert.equal(sc.status, "completed");
  assert.equal(sc.exit_code, 4);
  assert.equal(sc.output, "héllo wörld\n");

  const long = await modern("tools/call", { name: "exec_command", arguments: { cmd: "sleep 60", yield_time_ms: 200 } });
  const running = long.json.result.structuredContent;
  assert.equal(running.status, "running");
  assert.ok(running.session_id);

  const term = await modern("tools/call", { name: "write_stdin", arguments: { session_id: running.session_id, terminate: true, yield_time_ms: 8000 } });
  const ended = term.json.result.structuredContent;
  assert.equal(ended.status, "completed");
  assert.equal(ended.terminated_by, "client");

  const unknown = await modern("tools/call", { name: "write_stdin", arguments: { session_id: "deadbeef" } });
  assert.equal(unknown.json.result.isError, true);
});

test("view_image rejects non-images and returns image content for a PNG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpbox-png-"));
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  writeFileSync(join(dir, "a.png"), png);
  writeFileSync(join(dir, "b.png"), "nope");
  const ok = await modern("tools/call", { name: "view_image", arguments: { path: join(dir, "a.png") } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.result.content[0].type, "image");
  assert.equal(ok.json.result.content[0].mimeType, "image/png");
  assert.equal(ok.json.result.content[0].data, png.toString("base64"));
  const bad = await modern("tools/call", { name: "view_image", arguments: { path: join(dir, "b.png") } });
  assert.equal(bad.json.result.isError, true);
});

test("oversized body -> 413, invalid JSON -> 400", async () => {
  const big = await rawPost("/mcp", { ...H.json, ...H.auth }, Buffer.alloc(9 * 1024 * 1024, 32));
  assert.equal(big.status, 413);
  const badJson = await fetch(`${base}/mcp`, { method: "POST", headers: { ...H.json, ...H.auth }, body: "{not json" });
  assert.equal(badJson.status, 400);
});

test("server log never contains the token", () => {
  assert.ok(!stderr.includes(TOKEN), stderr);
});

test("legacy path token mode accepts /<token>/mcp when enabled", async () => {
  await stopServer();
  await startServer({ MCPBOX_LEGACY_PATH_TOKEN: "1" });
  const r = await fetch(`${base}/${TOKEN}/mcp`, {
    method: "POST",
    headers: H.json,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } })
  });
  assert.equal(r.status, 200);
  const wrong = await fetch(`${base}/${TOKEN}x/mcp`, { method: "POST", headers: H.json, body: modernBody(1, "tools/list") });
  assert.equal(wrong.status, 404);
  assert.match(stderr, /deprecated legacy path-token/);
  assert.ok(!stderr.includes(TOKEN));
});
