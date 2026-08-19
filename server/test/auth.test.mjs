import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAuth, checkHost, checkOrigin, hostnameOf, bearerFrom } from "../src/auth.mjs";

const TOKEN = "Zk8f3s0Q9x1vN2bC4dE5fG6hJ7kL8mN9pQ0rS1tU2vW";
const HOSTS = ["127.0.0.1", "localhost", "mcp"];

test("hostnameOf strips ports and brackets", () => {
  assert.equal(hostnameOf("localhost:33333"), "localhost");
  assert.equal(hostnameOf("127.0.0.1"), "127.0.0.1");
  assert.equal(hostnameOf("[::1]:3000"), "::1");
  assert.equal(hostnameOf("MCP:3000"), "mcp");
  assert.equal(hostnameOf(""), null);
  assert.equal(hostnameOf(undefined), null);
});

test("checkHost accepts allow-listed hosts and rejects others", () => {
  assert.equal(checkHost({ host: "localhost:33333" }, HOSTS), null);
  assert.equal(checkHost({ host: "mcp:3000" }, HOSTS), null);
  assert.equal(checkHost({ host: "evil.example:33333" }, HOSTS)?.status, 421);
  assert.equal(checkHost({}, HOSTS)?.status, 400);
  assert.equal(checkHost({ host: "anything" }, ["*"]), null);
});

test("checkOrigin: absent origin allowed, null rejected, host-based allow-list", () => {
  assert.equal(checkOrigin({}, HOSTS, []), null);
  assert.equal(checkOrigin({ origin: "" }, HOSTS, []), null);
  assert.equal(checkOrigin({ origin: "null" }, HOSTS, [])?.status, 403);
  assert.equal(checkOrigin({ origin: "http://localhost:5173" }, HOSTS, []), null);
  assert.equal(checkOrigin({ origin: "https://127.0.0.1" }, HOSTS, []), null);
  assert.equal(checkOrigin({ origin: "http://attacker.example" }, HOSTS, [])?.status, 403);
  assert.equal(checkOrigin({ origin: "http://localhost.attacker.example" }, HOSTS, [])?.status, 403);
  assert.equal(checkOrigin({ origin: "file://" }, HOSTS, [])?.status, 403);
  assert.equal(checkOrigin({ origin: "garbage" }, HOSTS, [])?.status, 403);
});

test("checkOrigin: explicit allowedOrigins and wildcard", () => {
  assert.equal(checkOrigin({ origin: "https://app.example.com" }, HOSTS, ["https://app.example.com"]), null);
  assert.equal(checkOrigin({ origin: "https://app.example.com/" }, HOSTS, ["https://app.example.com"]), null);
  assert.equal(checkOrigin({ origin: "https://other.example.com" }, HOSTS, ["https://app.example.com"])?.status, 403);
  assert.equal(checkOrigin({ origin: "https://other.example.com" }, HOSTS, ["*"]), null);
});

test("bearerFrom parses the Authorization header", () => {
  assert.equal(bearerFrom({ authorization: `Bearer ${TOKEN}` }), TOKEN);
  assert.equal(bearerFrom({ authorization: `bearer ${TOKEN}` }), TOKEN);
  assert.equal(bearerFrom({ authorization: `Basic abc` }), null);
  assert.equal(bearerFrom({}), null);
});

test("checkAuth: bearer token", () => {
  const cfg = { token: TOKEN, legacyPathToken: false };
  assert.equal(checkAuth({ headers: { authorization: `Bearer ${TOKEN}` } }, cfg), null);
  assert.equal(checkAuth({ headers: { authorization: `Bearer ${TOKEN}x` } }, cfg)?.status, 401);
  assert.equal(checkAuth({ headers: { authorization: `Bearer ` } }, cfg)?.status, 401);
  assert.equal(checkAuth({ headers: {} }, cfg)?.status, 401);
});

test("checkAuth: legacy path token only when enabled", () => {
  const off = { token: TOKEN, legacyPathToken: false };
  const on = { token: TOKEN, legacyPathToken: true };
  assert.equal(checkAuth({ headers: {}, pathToken: TOKEN }, off)?.status, 404);
  assert.equal(checkAuth({ headers: {}, pathToken: TOKEN }, on), null);
  assert.equal(checkAuth({ headers: {}, pathToken: "wrong" }, on)?.status, 404);
  // A bearer header takes precedence over the path even in legacy mode.
  assert.equal(checkAuth({ headers: { authorization: "Bearer nope" }, pathToken: TOKEN }, on)?.status, 401);
});

test("rejection messages never contain the token", () => {
  const cfg = { token: TOKEN, legacyPathToken: true };
  for (const r of [
    checkAuth({ headers: { authorization: `Bearer ${TOKEN}x` } }, cfg),
    checkAuth({ headers: {}, pathToken: `${TOKEN}x` }, cfg),
    checkAuth({ headers: {} }, cfg)
  ]) {
    assert.ok(r && !r.error.includes(TOKEN));
  }
});
