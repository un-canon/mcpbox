// Framework-agnostic request guards: Host validation, Origin validation and
// bearer-token authentication. Each function returns null when the request may
// proceed, or { status, error } describing a rejection. Messages are
// deliberately generic and never echo secrets or configuration values.

import { tokensEqual } from "./token.mjs";

/** Extract the hostname from a Host header value ("[::1]:33333" -> "::1"). */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== "string") return null;
  const value = hostHeader.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : null;
  }
  const colon = value.indexOf(":");
  return colon >= 0 ? value.slice(0, colon) : value;
}

export function checkHost(headers, allowedHosts) {
  const hostname = hostnameOf(headers.host);
  if (!hostname) return { status: 400, error: "Missing or malformed Host header" };
  const allowed = allowedHosts.map(h => h.toLowerCase());
  if (allowed.includes("*") || allowed.includes(hostname)) return null;
  return { status: 421, error: "Host not allowed" };
}

/**
 * Origin policy (MCP Streamable HTTP, DNS-rebinding protection):
 *  - no Origin header  -> allow (non-browser clients such as CLIs);
 *  - Origin "null"     -> reject;
 *  - Origin present    -> its host must be one of allowedHosts (any port,
 *                         http/https), or the full origin must be listed in
 *                         allowedOrigins. "*" in allowedOrigins allows all.
 */
export function checkOrigin(headers, allowedHosts, allowedOrigins) {
  const origin = headers.origin;
  if (origin === undefined || origin === "") return null;
  const value = String(origin).trim().toLowerCase();
  if (allowedOrigins.includes("*")) return null;
  if (value === "null") return { status: 403, error: "Origin not allowed" };
  if (allowedOrigins.map(o => o.toLowerCase().replace(/\/$/, "")).includes(value.replace(/\/$/, ""))) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { status: 403, error: "Origin not allowed" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: 403, error: "Origin not allowed" };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (allowedHosts.map(h => h.toLowerCase()).includes(hostname)) return null;
  return { status: 403, error: "Origin not allowed" };
}

/** Parse "Authorization: Bearer <token>" (case-insensitive scheme). */
export function bearerFrom(headers) {
  const value = headers.authorization;
  if (typeof value !== "string") return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1] : null;
}

/**
 * Authenticate a request. `pathToken` is the token segment from a legacy
 * /<token>/mcp URL, or null.
 */
export function checkAuth({ headers, pathToken = null }, { token, legacyPathToken }) {
  const bearer = bearerFrom(headers);
  if (bearer !== null) {
    return tokensEqual(token, bearer) ? null : { status: 401, error: "Invalid bearer token" };
  }
  if (pathToken !== null) {
    if (!legacyPathToken) return { status: 404, error: "Not found" };
    return tokensEqual(token, pathToken) ? null : { status: 404, error: "Not found" };
  }
  return { status: 401, error: "Missing bearer token" };
}
