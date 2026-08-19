// Runtime configuration for the MCPBox MCP server. Everything is read from
// environment variables (set by compose.yaml / .env) with defaults suited to a
// personal development machine.

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function listEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const previous = process.env;
  // Allow tests to pass a custom env object.
  if (env !== process.env) process.env = env;
  try {
    return {
      port: intEnv("MCPBOX_PORT", 3000, { min: 1, max: 65535 }),
      bindHost: process.env.MCPBOX_BIND || "0.0.0.0",
      tokenFile: process.env.MCPBOX_TOKEN_FILE || "/run/secrets/mcpbox-token",
      workdir: process.env.MCPBOX_WORKDIR || "/workspace/project",
      mcpPath: process.env.MCPBOX_MCP_PATH || "/mcp",
      legacyPathToken: boolEnv("MCPBOX_LEGACY_PATH_TOKEN", false),
      allowedHosts: listEnv("MCPBOX_ALLOWED_HOSTS", ["127.0.0.1", "localhost", "mcp"]),
      allowedOrigins: listEnv("MCPBOX_ALLOWED_ORIGINS", []),
      maxSessions: intEnv("MCPBOX_MAX_SESSIONS", 16, { min: 1, max: 1000 }),
      maxRuntimeMs: intEnv("MCPBOX_MAX_RUNTIME_MS", 60 * 60 * 1000, { min: 1000 }),
      idleTimeoutMs: intEnv("MCPBOX_IDLE_TIMEOUT_MS", 30 * 60 * 1000, { min: 1000 }),
      killGraceMs: intEnv("MCPBOX_KILL_GRACE_MS", 5000, { min: 100, max: 120_000 }),
      maxBufferChars: intEnv("MCPBOX_MAX_BUFFER_CHARS", 2_000_000, { min: 10_000 }),
      maxResultChars: intEnv("MCPBOX_MAX_RESULT_CHARS", 100_000, { min: 1000 }),
      maxImageBytes: intEnv("MCPBOX_MAX_IMAGE_BYTES", 12 * 1024 * 1024, { min: 1024 }),
      maxConcurrentRequests: intEnv("MCPBOX_MAX_CONCURRENT_REQUESTS", 32, { min: 1 }),
      finishedRetentionMs: intEnv("MCPBOX_FINISHED_RETENTION_MS", 60 * 60 * 1000, { min: 1000 }),
      logLevel: process.env.MCPBOX_LOG_LEVEL || "info"
    };
  } finally {
    process.env = previous;
  }
}
