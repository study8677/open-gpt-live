import type { GatewayLogger } from "./gateway.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createJsonLogger(minimumLevel: LogLevel): GatewayLogger {
  const write = (
    level: Exclude<LogLevel, "debug">,
    event: string,
    fields: Record<string, unknown> = {}
  ): void => {
    if (levels[level] < levels[minimumLevel]) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitize(fields)
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (/authorization|api.?key|token|audio|transcript|content/i.test(key)) {
        return [key, "[redacted]"];
      }
      if (value instanceof Error) return [key, value.message.slice(0, 1_000)];
      if (typeof value === "string") return [key, value.slice(0, 1_000)];
      return [key, value];
    })
  );
}
