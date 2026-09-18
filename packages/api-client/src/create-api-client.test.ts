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

const CATEGORY_ID = "0b6f7a2e-2c55-4f0e-9d8e-3b1c2a4d5e6f";

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

  it("sends a route's JSON body and resolves its documented response", async () => {
    const sent = {
      phone: "+77011234567",
      channel: "whatsapp",
      codeLength: 6,
      expiresAt: "2026-09-17T00:05:00.000Z",
      resendAvailableAt: "2026-09-17T00:01:00.000Z",
    };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, sent));
    const client = clientWith(fetchImpl);

    await expect(client.requestLoginCode({ phone: "8 701 123 45 67" })).resolves.toEqual(sent);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://api.test/auth/login-code");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ phone: "8 701 123 45 67" });
  });

  it("does not send a body or Content-Type on a route without one", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
    await clientWith(fetchImpl).getHealth();
    expect(fetchImpl.mock.calls[0]![1].body).toBeUndefined();
    expect(fetchImpl.mock.calls[0]![1].headers).not.toHaveProperty("Content-Type");
  });

  it("exposes rate limit details of a login code error", async () => {
    const body = {
      code: "RATE_LIMITED",
      message: "Too many requests",
      details: { limit: "login_code_resend_interval", retryAfterSeconds: 42 },
      retryable: true,
    };
    const client = clientWith(vi.fn<FetchLike>().mockResolvedValue(jsonResponse(429, body)));
    const error = await captureError(
      client.verifyLoginCode({ phone: "+77011234567", code: "123456" }),
    );
    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
      details: body.details,
    });
  });

  it("refuses to call a route that needs a body without one", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const client = clientWith(fetchImpl);
    await expect(client.request(apiRoutes.requestLoginCode)).rejects.toThrow(
      /requires a request body/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
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

  describe("sessions", () => {
    const SESSION_ID = "0b9b3f0e-7c1a-4b8e-9d42-1f0c2a3b4c5d";

    it("sends the access token only to routes that require a session", async () => {
      const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
      const client = clientWith(fetchImpl, { getAccessToken: () => "access-1" });

      await client.getCurrentAccount();
      await client.getHealth();
      await client.verifyLoginCode({ phone: "+77011234567", code: "123456" });
      await client.refreshSession({ refreshToken: "refresh-1" });

      const authorization = fetchImpl.mock.calls.map(
        ([, init]) => (init.headers as Record<string, string>).Authorization,
      );
      expect(authorization).toEqual(["Bearer access-1", undefined, undefined, undefined]);
    });

    it("reads the access token on every request and omits it when there is none", async () => {
      const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { sessions: [] }));
      const current: { token?: string } = {};
      const client = clientWith(fetchImpl, { getAccessToken: () => current.token });

      await client.listSessions();
      current.token = "access-2";
      await client.listSessions();

      expect(fetchImpl.mock.calls[0]![1].headers).not.toHaveProperty("Authorization");
      expect(fetchImpl.mock.calls[1]![1].headers).toMatchObject({
        Authorization: "Bearer access-2",
      });
    });

    it("fills path parameters", async () => {
      const fetchImpl = vi
        .fn<FetchLike>()
        .mockResolvedValue(jsonResponse(200, { ended: 1, currentEnded: false }));
      const client = clientWith(fetchImpl);

      await expect(client.endSession({ sessionId: SESSION_ID })).resolves.toEqual({
        ended: 1,
        currentEnded: false,
      });

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(`http://api.test/auth/sessions/${SESSION_ID}`);
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
    });

    it("sends a settings change with its key, body and the access token", async () => {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
      const client = clientWith(fetchImpl, { getAccessToken: () => "admin-access" });

      await client.changeSetting(
        { key: "rating_min_reviews" },
        { value: 7, expectedVersion: 2, reason: "Больше оценок" },
      );

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("http://api.test/admin/settings/rating_min_reviews");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(String(init.body))).toEqual({
        value: 7,
        expectedVersion: 2,
        reason: "Больше оценок",
      });
      expect(init.headers).toMatchObject({ Authorization: "Bearer admin-access" });
    });

    it("reads the catalog as a guest in the UI language, and patches a category as an administrator", async () => {
      const fetchImpl = vi
        .fn<FetchLike>()
        .mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
      const guest = clientWith(fetchImpl, {
        getAccessToken: () => "user-access",
        getLanguage: () => "kk",
      });
      await guest.getCatalogCategoryAttributes({ categoryId: CATEGORY_ID });
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(`http://api.test/catalog/categories/${CATEGORY_ID}/attributes`);
      expect(init.headers).toMatchObject({ "Accept-Language": "kk" });
      // A public route: the token isn't sent.
      expect(init.headers).not.toHaveProperty("Authorization");

      const admin = clientWith(fetchImpl, { getAccessToken: () => "admin-access" });
      await admin.updateCategory(
        { categoryId: CATEGORY_ID },
        { expectedVersion: 3, names: { ru: "Колодки", kk: null } },
      );
      const [patchUrl, patch] = fetchImpl.mock.calls[1]!;
      expect(patchUrl).toBe(`http://api.test/admin/catalog/categories/${CATEGORY_ID}`);
      expect(patch.method).toBe("PATCH");
      expect(JSON.parse(String(patch.body))).toEqual({
        expectedVersion: 3,
        names: { ru: "Колодки", kk: null },
      });
      expect(patch.headers).toMatchObject({ Authorization: "Bearer admin-access" });
    });

    it("refuses to call a route without its path parameters", async () => {
      const fetchImpl = vi.fn<FetchLike>();
      const client = clientWith(fetchImpl);
      await expect(client.request(apiRoutes.endSession)).rejects.toThrow(/sessionId/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("passes the credentials mode for cookie-based web sessions", async () => {
      const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
      await clientWith(fetchImpl, { credentials: "include" }).refreshSession({});
      expect(fetchImpl.mock.calls[0]![1].credentials).toBe("include");

      await clientWith(fetchImpl).refreshSession({});
      expect(fetchImpl.mock.calls[1]![1]).not.toHaveProperty("credentials");
    });

    it("tells an expired access token from an ended session", async () => {
      const respond = (code: string) =>
        vi
          .fn<FetchLike>()
          .mockResolvedValue(jsonResponse(401, { code, message: "no", retryable: false }));
      const expired = await captureError(
        clientWith(respond("ACCESS_TOKEN_EXPIRED")).getCurrentAccount(),
      );
      const ended = await captureError(clientWith(respond("SESSION_ENDED")).getCurrentAccount());
      expect(expired).toMatchObject({ code: "ACCESS_TOKEN_EXPIRED", status: 401 });
      expect(ended).toMatchObject({ code: "SESSION_ENDED", status: 401 });
    });
  });
});
