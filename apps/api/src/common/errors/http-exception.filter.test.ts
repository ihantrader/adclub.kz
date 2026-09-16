import { ConflictException, NotFoundException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ApiErrorResponse } from "@adclub/contracts";
import { z } from "zod";
import { JsonLoggerService } from "../logging/json-logger.service";
import { ZodValidationException } from "../validation/zod-validation.exception";
import { ClientUpdateRequiredException } from "./client-update-required.exception";
import { HttpExceptionFilter } from "./http-exception.filter";

function fakeHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const response = { status, json };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
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

describe("HttpExceptionFilter", () => {
  it("formats a ZodValidationException as VALIDATION_ERROR (400)", () => {
    const filter = new HttpExceptionFilter(fakeLogger());
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
    const filter = new HttpExceptionFilter(fakeLogger());
    const { host, status, json } = fakeHost();

    filter.catch(new NotFoundException("Route not found"), host);

    expect(status).toHaveBeenCalledWith(404);
    const body = json.mock.calls[0]?.[0] as ApiErrorResponse;
    expect(body).toEqual({ code: "NOT_FOUND", message: "Route not found", retryable: false });
  });

  it("formats a ConflictException as CONFLICT (409)", () => {
    const filter = new HttpExceptionFilter(fakeLogger());
    const { host, status, json } = fakeHost();

    filter.catch(new ConflictException("Already exists"), host);

    expect(status).toHaveBeenCalledWith(409);
    const body = json.mock.calls[0]?.[0] as ApiErrorResponse;
    expect(body.code).toBe("CONFLICT");
  });

  it("formats a ClientUpdateRequiredException as CLIENT_UPDATE_REQUIRED (426) with its details", () => {
    const filter = new HttpExceptionFilter(fakeLogger());
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
    const filter = new HttpExceptionFilter(fakeLogger());
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
    const filter = new HttpExceptionFilter(logger);
    const { host } = fakeHost();
    const error = new Error("db exploded");

    filter.catch(error, host);

    expect(logger.error).toHaveBeenCalledWith(error, "ExceptionFilter");
  });

  it("does not log 4xx errors as server errors", () => {
    const logger = fakeLogger();
    const filter = new HttpExceptionFilter(logger);
    const { host } = fakeHost();

    filter.catch(new NotFoundException(), host);

    expect(logger.error).not.toHaveBeenCalled();
  });
});
