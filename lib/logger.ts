export type LogFields = Record<string, unknown>;

type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  const time = new Date().toISOString();
  // Base properties spread last so a caller-supplied field can never shadow
  // level/msg/time.
  const record = { ...fields, level, msg, time };

  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    // `fields` is caller-controlled and may be circular or otherwise
    // non-serializable; never let that crash the logger itself.
    serialized = JSON.stringify({ level, msg, time });
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
