import { Inject, Injectable, type LoggerService } from "@nestjs/common";
import { APP_CONFIG, type AppConfig, type LogLevel, logLevels } from "../../config";
import { getRequestId } from "./request-context";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  requestId?: string;
  stack?: string;
}

/**
 * Structured (single-line JSON) logger, used both as the Nest framework
 * logger (`app.useLogger`) and injectable in application code. Deliberately
 * narrow: only a message/context/stack are ever recorded — request bodies
 * and headers never reach it (ARCHITECTURE 15.3 full PII masking is
 * TASK-009; here it's enough that nothing sensitive is passed in).
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

    const context = optionalParams.find((param): param is string => typeof param === "string");

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: message instanceof Error ? message.message : String(message),
      context,
      requestId: getRequestId(),
      stack: message instanceof Error ? message.stack : undefined,
    };

    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(entry)}\n`);
  }
}
