/**
 * The SDK logger.
 *
 * The seam needs somewhere to put a warning that is not an error: a duplicate
 * strategy id replaces the earlier registration rather than throwing, and a
 * consumer has to be able to see that happen without the SDK deciding for them
 * that it deserves a crash. Design section 9.3 names the behaviour; this is the
 * sink it writes to.
 *
 * The interface is four methods and one optional field bag, so a consumer can
 * hand in `pino`, `winston`, or a closure over an array in a test without an
 * adapter. Nothing here formats, filters, or buffers.
 *
 * Requirements: 23.6
 */

/** Structured fields attached to one log line. Values are rendered by the sink. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Discards every line. The right default inside a library test. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Writes to the host console, prefixing every line with `tab:` so a Service
 * operator can tell an SDK line from their own.
 */
export const consoleLogger: Logger = {
  debug: (message, fields) => emit("debug", message, fields),
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),
};

/**
 * The logger used when a caller supplies none.
 *
 * The console rather than silence, because the one thing this sink exists to
 * carry — a strategy registration that replaced another — is invisible
 * otherwise, and a silently swapped payment strategy is the kind of surprise
 * that costs money.
 */
export const defaultLogger: Logger = consoleLogger;

function emit(level: "debug" | "info" | "warn" | "error", message: string, fields?: LogFields): void {
  const line = `tab: ${message}`;
  if (fields === undefined) {
    console[level](line);
    return;
  }
  console[level](line, fields);
}
