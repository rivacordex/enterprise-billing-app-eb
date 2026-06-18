export type LogFields = Record<string, unknown>;

type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  const record = { ...fields, level, msg, time: new Date().toISOString() };
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    serialized = JSON.stringify({ level, msg, time: record.time });
  }
  // eslint-disable-next-line no-console -- lib/logger.ts is the single sanctioned console sink (code-standards §1.10)
  console[level](serialized);
}

export const logger = {
  debug(msg: string, fields?: LogFields): void {
    write("debug", msg, fields);
  },
  info(msg: string, fields?: LogFields): void {
    write("info", msg, fields);
  },
  warn(msg: string, fields?: LogFields): void {
    write("warn", msg, fields);
  },
  error(msg: string, fields?: LogFields): void {
    write("error", msg, fields);
  },
};

/**
 * Extension point for the GlitchTip + OpenTelemetry transport wired in um25.
 * Currently writes a structured log record only.
 */
export function reportError(error: unknown, context?: LogFields): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  logger.error(message, {
    ...context,
    name: error instanceof Error ? error.name : undefined,
  });
}
