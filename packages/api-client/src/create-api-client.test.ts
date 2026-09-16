import { apiRoutes } from "@adclub/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError, isApiError } from "./api-error";
import { createApiClient, type FetchLike } from "./create-api-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(
  fetchImpl: FetchLike,
  extra: Partial<Parameters<typeof createApiClient>[0]> = {},
) {
  return createApiClient({
    baseUrl: "http://api.test/",
    client: { platform: "ios", version: "1.4.2" },
    fetch: fetchImpl,
    ...extra,
  });
}

async function captureError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("createApiClient", () => {
  it("exposes one method per contract route", () => {
    const client = clientWith(vi.fn());
    for (const name of Object.keys(apiRoutes)) {
      expect(typeof client[name as keyof typeof apiRoutes]).toBe("function");
    }
  });

  it("calls the route path with the client and language headers", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        jsonResponse(200, { status: "ok", service: "api", timestamp: "2026-09-17T00:00:00.000Z" }),
      );
    const client = clientWith(fetchImpl, { getLanguage: () => "kk" });

    const health = await client.getHealth();

    expect(health.status).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://api.test/health");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({
      "X-Client": "mobile/1.4.2 (ios)",
      "Accept-Language": "kk",
      Accept: "application/json",
    });
  });

  it("omits Accept-Language when no language is known", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
    await clientWith(fetchImpl).getHealth();
    expect(fetchImpl.mock.calls[0]![1].headers).not.toHaveProperty("Accept-Language");
  });

  it("resolves a documented non-2xx response as data (readiness 503)", async () => {
    const degraded = {
      status: "degraded",
      checks: {
        postgres: { status: "error", error: "down" },
        redis: { status: "ok", latencyMs: 1 },
        s3: { status: "ok", latencyMs: 1 },
      },
    };
    const client = clientWith(vi.fn<FetchLike>().mockResolvedValue(jsonResponse(503, degraded)));

    await expect(client.getReadiness()).resolves.toEqual(degraded);
  });

  it("does not reject a response carrying fields or enum values added by a newer server", async () => {
    const newer = {
      status: "ok",
      service: "search-indexer",
      timestamp: "2026-09-17T00:00:00.000Z",
      region: "almaty",
    };
    const client = clientWith(vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, newer)));

    await expect(client.getHealth()).resolves.toEqual(newer);
  });

  it("turns the unified error format into a typed ApiError", async () => {
    const onError = vi.fn();
    const body = {
      code: "CLIENT_UPDATE_REQUIRED",
      message: "Обновите приложение",
      details: { platform: "ios", clientVersion: "1.4.2", minSupportedVersion: "2.0.0" },
      retryable: false,
    };
    const client = clientWith(vi.fn<FetchLike>().mockResolvedValue(jsonResponse(426, body)), {
      onError,
    });

    const error = await captureError(client.getReadiness());

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "CLIENT_UPDATE_REQUIRED",
      message: "Обновите приложение",
      status: 426,
      retryable: false,
      details: body.details,
    });
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("maps an error code unknown to this client version to UNKNOWN_ERROR, keeping the raw code", async () => {
    const client = clientWith(
      vi
        .fn<FetchLike>()
        .mockResolvedValue(
          jsonResponse(402, { code: "SUBSCRIPTION_REQUIRED", message: "Pay", retryable: false }),
        ),
    );

    const error = await captureError(client.getReadiness());

    expect(error.code).toBe("UNKNOWN_ERROR");
    expect(error.serverCode).toBe("SUBSCRIPTION_REQUIRED");
    expect(error.message).toBe("Pay");
  });

  it("handles a non-JSON error page (e.g. from a proxy)", async () => {
    const client = clientWith(
      vi
        .fn<FetchLike>()
        .mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 })),
    );

    const error = await captureError(client.getHealth());

    expect(error).toMatchObject({ code: "UNKNOWN_ERROR", status: 502, retryable: true });
  });

  it("reports INVALID_RESPONSE when a documented response is not JSON", async () => {
    const client = clientWith(
      vi.fn<FetchLike>().mockResolvedValue(new Response("not json", { status: 200 })),
    );

    const error = await captureError(client.getHealth());

    expect(error).toMatchObject({ code: "INVALID_RESPONSE", status: 200 });
  });

  it("reports NETWORK_ERROR when the server can't be reached", async () => {
    const onError = vi.fn();
    const client = clientWith(
      vi.fn<FetchLike>().mockRejectedValue(new TypeError("Network request failed")),
      {
        onError,
      },
    );

    const error = await captureError(client.getClientPolicy());

    expect(error).toMatchObject({ code: "NETWORK_ERROR", status: 0, retryable: true });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("times out a request that never answers", async () => {
    const hangingFetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = clientWith(hangingFetch, { timeoutMs: 20 });

    const error = await captureError(client.getClientPolicy());

    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message).toContain("20 ms");
  });

  it("propagates a caller's cancellation without reporting it as an API error", async () => {
    const onError = vi.fn();
    const hangingFetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const client = clientWith(hangingFetch, { onError });
    const controller = new AbortController();

    const pending = client.getHealth({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("formats the X-Client header for web platforms", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
    const client = createApiClient({
      baseUrl: "http://api.test",
      client: { platform: "admin-web", version: "0.1.0" },
      fetch: fetchImpl,
    });

    await client.getHealth();

    expect(fetchImpl.mock.calls[0]![0]).toBe("http://api.test/health");
    expect(fetchImpl.mock.calls[0]![1].headers).toMatchObject({ "X-Client": "admin-web/0.1.0" });
  });
});
