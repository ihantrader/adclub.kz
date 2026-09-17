import { Inject, Injectable, type LoggerService } from "@nestjs/common";
import { APP_CONFIG, type AppConfig, type LogLevel, logLevels } from "../../config";
import { sanitizeForLog, sanitizeForTransport } from "../../observability/sanitizer";
import { getRequestId } from "./request-context";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  requestId?: string;
  stack?: string;
  /** Anything else the caller passed along (objects, values) — sanitized. */
  details?: unknown;
}

/** A stack trace, not a context name: Nest passes both as strings. */
function looksLikeStack(value: string): boolean {
  return /\n\s+at\s/.test(value) || value.includes("\n");
}

/**
 * Structured (single-line JSON) logger, used both as the Nest framework
 * logger (`app.useLogger`) and injectable in application code.
 *
 * Every part of a line goes through the sanitizer (ARCHITECTURE 15.3,
 * 4.13): a phone number is written as `+7***1234` wherever it appears,
 * tokens, codes, e-mail, addresses and query strings never appear at all.
 * Objects are written as sanitized JSON in `details`, not as
 * `[object Object]`; when Nest hands over a stack trace, the context name
 * still reaches `context` (TASK-005.A note, closed in TASK-009).
 */
@Injectable()
export class JsonLoggerService implements LoggerService {
  private readonly threshold: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.threshold = logLevels.indexOf(config.logLevel);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    if (logLevels.indexOf(level) > this.threshold) {
      return;
    }

    // Nest calls `error(message, stack, context)` and `log(message,
    // context)`: the context is the last string, a stack is recognizable.
    const strings = optionalParams.filter((param): param is string => typeof param === "string");
    const contexts = strings.filter((param) => !looksLikeStack(param));
    const context = contexts.at(-1);
    const passedStack = strings.find(looksLikeStack);
    const details = optionalParams.filter(
      (param) => typeof param !== "string" && param !== undefined,
    );

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitizeForLog(message instanceof Error ? message.message : String(message)),
      context: context === undefined ? undefined : sanitizeForLog(context),
      requestId: getRequestId(),
      stack: this.stackOf(message, passedStack),
      details: this.detailsOf(details),
    };

    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(entry)}\n`);
  }

  private stackOf(message: unknown, passedStack: string | undefined): string | undefined {
    const stack = message instanceof Error ? message.stack : passedStack;
    return stack === undefined ? undefined : sanitizeForLog(stack);
  }

  private detailsOf(details: unknown[]): unknown {
    if (details.length === 0) {
      return undefined;
    }
    const cleaned = sanitizeForTransport(details.length === 1 ? details[0] : details);
    // A value that can't be cleaned is never written as it was.
    return cleaned.ok ? cleaned.value : "[sanitizer failed]";
  }
}
