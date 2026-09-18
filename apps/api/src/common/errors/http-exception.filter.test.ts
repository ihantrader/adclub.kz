import {
  ConflictException,
  GoneException,
  HttpException,
  MethodNotAllowedException,
  NotAcceptableException,
  NotFoundException,
  PayloadTooLargeException,
  RequestTimeoutException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ApiErrorResponse } from "@adclub/contracts";
import { z } from "zod";
import type { ErrorReporter } from "../../observability";
import { JsonLoggerService } from "../logging/json-logger.service";
import { ZodValidationException } from "../validation/zod-validation.exception";
import { ClientUpdateRequiredException } from "./client-update-required.exception";
import { codeForHttpStatus, HttpExceptionFilter } from "./http-exception.filter";

function fakeHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const setHeader = vi.fn();
  const response = { status, json, setHeader };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json, setHeader };
}

function fakeLogger(): JsonLoggerService {
  return {
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  } as unknown as JsonLoggerService;
}

function fakeReporter(): ErrorReporter {
  return { captureException: vi.fn(), enabled: true } as unknown as ErrorReporter;
}

describe("HttpExceptionFilter", () => {
  it("formats a ZodValidationException as VALIDATION_ERROR (400)", () => {
    const filter = new HttpExceptionFilter(fakeLogger(), fakeReporter());
    const schema = z.object({ phone: z.string() });
    const parseResult = schema.safeParse({});
    if (parseResult.success) {
      throw new Error("test fixture expected zod parse to fail");
    }
    const exception = new ZodValidationException(parseResult.error);
    const { host, status, json } = fakeHost();

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0]?.[0] as ApiErrorResponse;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.retryable).toBe(false);
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("formats a NotFoundException as NOT_FOUND (404)", () => {
    const filter = new HttpExceptionFilter(fakeLogger(), fakeReporter());
    const { host, status, json } = fakeHost();

    filter.catch(new NotFoundException("Route not found"), host);

    expect(status).toHaveBeenCalledWith(404);
    const body = json.mock.calls[0]?.[0] as ApiErrorResponse;
    expect(body).toEqual({ code: "NOT_FOUND", message: "Route not found", retryable: false });
  });

  it("lets no client or proxy keep an error, whatever the route set before failing (TASK-010.A)", () => {
    const filter = new HttpExceptionFilter(fakeLogger(), fakeReporter());
    for (const exception of [new NotFoundException(), new Error("boom")]) {
      const { host, setHeader } = fakeHost();
      filter.catch(exception, host);
      expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    }
  });

  it("formats a ConflictException as CONFLICT (409)", () => {
    const filter = new HttpExceptionFilter(fakeLogger(), fakeReporter());
    const { host, status, json } = fakeHost();

    filter.catch(new ConflictException("Already exists"), host);

    expect(status).toHaveBeenCalledWith(409);
    const body = json.mock.calls[0]?.[0] as ApiErrorResponse;
    expect(body.code).toBe("CONFLICT");
  });

  it("formats a ClientUpdateRequiredException as CLIENT_UPDATE_REQUIRED (426) with its details", () => {
    const filter = new HttpExceptionFilter(fakeLogger(), fakeReporter());
    const { host, status, json } = fakeHost();
    const details = {
      platform: "ios" as const,
      clientVersion: "1.0.0",
      minSupportedVersion: "2.0.0",
    };

    filter.catch(new ClientUpdateRequiredException("Обновите приложение", details), host);

    expect(status).toHaveBeenCalledWith(426);
    expect(json.mock.calls[0]?.[0]).toEqual({
      code: "CLIENT_UPDATE_REQUIRED",
      message: "Обновите приложение",
      details,
      retryable: false,
    });
  });

  it("formats an unexpected error as INTERNAL_ERROR (500) without leaking its message or stack", () => {
    const filter = new HttpExceptionFilter(fakeLogger(), fakeReporter());
    const { host, status, json } = fakeHost();

    filter.catch(new Error("password=hunter2 leaked from a driver"), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]?.[0] as ApiErrorResponse;
    expect(body).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(body).not.toHaveProperty("stack");
  });

  it("logs the full error server-side for 500s", () => {
    const logger = fakeLogger();
    const filter = new HttpExceptionFilter(logger, fakeReporter());
    const { host } = fakeHost();
    const error = new Error("db exploded");

    filter.catch(error, host);

    expect(logger.error).toHaveBeenCalledWith(error, "ExceptionFilter");
  });

  it("does not log 4xx errors as server errors", () => {
    const logger = fakeLogger();
    const filter = new HttpExceptionFilter(logger, fakeReporter());
    const { host } = fakeHost();

    filter.catch(new NotFoundException(), host);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure to error monitoring, and a 4xx never (TASK-009)", () => {
    const reporter = fakeReporter();
    const filter = new HttpExceptionFilter(fakeLogger(), reporter);
    const { host } = fakeHost();

    filter.catch(new NotFoundException(), host);
    expect(reporter.captureException).not.toHaveBeenCalled();

    filter.catch(new Error("db exploded"), host);
    expect(reporter.captureException).toHaveBeenCalledTimes(1);
    const [, context] = (reporter.captureException as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]!;
    expect(context).toMatchObject({ tags: { kind: "api", status: 500 } });
  });

  it.each([
    [new MethodNotAllowedException(), 405, "METHOD_NOT_ALLOWED"],
    [new NotAcceptableException(), 406, "NOT_ACCEPTABLE"],
    [new RequestTimeoutException(), 408, "REQUEST_TIMEOUT"],
    [new GoneException(), 410, "GONE"],
    [new PayloadTooLargeException(), 413, "PAYLOAD_TOO_LARGE"],
    [new HttpException("URI Too Long", 414), 414, "URI_TOO_LONG"],
    [new UnsupportedMediaTypeException(), 415, "UNSUPPORTED_MEDIA_TYPE"],
    [new HttpException("Expectation Failed", 417), 417, "REQUEST_REJECTED"],
    [new HttpException("Request Header Fields Too Large", 431), 431, "REQUEST_REJECTED"],
    [new UnprocessableEntityException(), 422, "VALIDATION_ERROR"],
  ])(
    "gives %#: a 4xx of its own a code that fits its meaning, not VALIDATION_ERROR (TASK-009.A)",
    (exception, code, expected) => {
      const filter = new HttpExceptionFilter(fakeLogger(), fakeReporter());
      const { host, status, json } = fakeHost();

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(code);
      expect((json.mock.calls[0]?.[0] as ApiErrorResponse).code).toBe(expected);
    },
  );

  it("answers any 4xx status without a code of its own with REQUEST_REJECTED, never VALIDATION_ERROR", () => {
    for (let status = 400; status < 500; status += 1) {
      const code = codeForHttpStatus(status);
      if (status === 400 || status === 422) {
        expect(code, String(status)).toBe("VALIDATION_ERROR");
      } else {
        expect(code, String(status)).not.toBe("VALIDATION_ERROR");
        expect(code, String(status)).not.toBe("INTERNAL_ERROR");
      }
    }
  });

  /** An error as `body-parser` (through `http-errors`) raises it. */
  function parserError(status: number, type: string, message: string): Error {
    return Object.assign(new SyntaxError(message), {
      status,
      statusCode: status,
      type,
      expose: true,
    });
  }

  it.each([
    [
      parserError(
        400,
        "entity.parse.failed",
        `Unexpected token 'b', "{bad +77011234567" is not valid JSON`,
      ),
      400,
      "MALFORMED_REQUEST",
    ],
    [parserError(413, "entity.too.large", "request entity too large"), 413, "PAYLOAD_TOO_LARGE"],
    [
      parserError(415, "charset.unsupported", 'unsupported charset "KOI8-R"'),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    ],
    [parserError(400, "request.aborted", "request aborted"), 400, "MALFORMED_REQUEST"],
  ])(
    "turns a body the parser refused (%#) into its code, not a 500, and never echoes it",
    (error, code, expected) => {
      const logger = fakeLogger();
      const reporter = fakeReporter();
      const filter = new HttpExceptionFilter(logger, reporter);
      const { host, status, json } = fakeHost();

      filter.catch(error, host);

      expect(status).toHaveBeenCalledWith(code);
      const body = json.mock.calls[0]?.[0] as ApiErrorResponse;
      expect(body.code).toBe(expected);
      expect(body.message).not.toContain("77011234567");
      expect(logger.error).not.toHaveBeenCalled();
      expect(reporter.captureException).not.toHaveBeenCalled();
    },
  );
});
