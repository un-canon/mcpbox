// Minimal structured logger. Never pass secrets in `fields`.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info", stream = process.stderr) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, message, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const line = { time: new Date().toISOString(), level: lvl, message, ...(fields || {}) };
    stream.write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f)
  };
}
