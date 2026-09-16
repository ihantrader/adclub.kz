import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { JsonLoggerService } from "./json-logger.service";

/**
 * Logs one line per HTTP request: method, path, status, duration. Never
 * the body or headers — those can carry personal data (ARCHITECTURE 15.3).
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  // See HttpExceptionFilter for why `@Inject` is required here.
  constructor(@Inject(JsonLoggerService) private readonly logger: JsonLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = Date.now();

    // Listening for 'finish' (not an rxjs `tap`) is what makes this
    // correct for error responses too: the exception filter sets the
    // real status code *after* the observable errors, so reading
    // `response.statusCode` from `tap`'s error callback logged the
    // pre-error default (200) instead — found by curling a 404 for real
    // and seeing it logged as 200.
    response.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `${request.method} ${request.originalUrl} ${response.statusCode} ${durationMs}ms`,
        "HTTP",
      );
    });

    return next.handle();
  }
}
