import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_TOKEN_LENGTH = 32;
// Accept hex, base64, base64url and common "safe" punctuation. Whitespace and
// control characters are rejected outright.
const TOKEN_CHARSET = /^[A-Za-z0-9._~+/=-]+$/;
// Roughly 4 bits per char over the accepted alphabet; a 32-char token with at
// least this many distinct characters is a reasonable proxy for "not a typed
// placeholder". Real tokens from setup.sh have ~24+ distinct chars.
const MIN_DISTINCT_CHARS = 10;

export class TokenError extends Error {}

/**
 * Validate a candidate token. Returns the trimmed token or throws TokenError.
 * The error message never includes the token itself.
 */
export function validateToken(raw) {
  if (typeof raw !== "string") throw new TokenError("token must be a string");
  const token = raw.replace(/\r?\n$/, "").trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new TokenError(`token must contain at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (token.length > 512) throw new TokenError("token is unreasonably long (>512 chars)");
  if (!TOKEN_CHARSET.test(token)) {
    throw new TokenError("token contains characters outside [A-Za-z0-9._~+/=-]");
  }
  const distinct = new Set(token).size;
  if (distinct < MIN_DISTINCT_CHARS) {
    throw new TokenError("token looks low-entropy (too few distinct characters); generate one with openssl rand");
  }
  return token;
}

export function loadTokenFromFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Do not leak the full error (it may contain the path); the path itself is
    // configuration, not secret, but keep messages short and stable.
    throw new TokenError(`cannot read token file (${error.code || "error"})`);
  }
  return validateToken(raw);
}

/**
 * Constant-time comparison that does not leak length via early return.
 */
export function tokensEqual(expected, candidate) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(candidate, "utf8").digest();
  return timingSafeEqual(a, b);
}
