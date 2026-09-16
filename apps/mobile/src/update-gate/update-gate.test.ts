import { ApiError, createApiClient, type FetchLike } from "@adclub/api-client";
import type { ClientPolicyResponse } from "@adclub/contracts";
import { describe, expect, it, vi } from "vitest";
import { evaluateClientPolicy, shouldShowUpdateScreen, UpdateGate } from "./update-gate";

const ios = { platform: "ios", version: "1.4.2" } as const;
const android = { platform: "android", version: "1.4.2" } as const;

function policy(
  ios: string,
  android: string,
  message = "Обновите приложение",
): ClientPolicyResponse {
  return {
    platforms: {
      ios: { minSupportedVersion: ios },
      android: { minSupportedVersion: android },
      "supplier-web": { minSupportedVersion: "0.0.0" },
      "admin-web": { minSupportedVersion: "0.0.0" },
    },
    message,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Wires a gate and a real API client exactly like `src/services/api.ts`, over a fake network. */
function appWith(fetchImpl: FetchLike, client: typeof ios | typeof android = ios) {
  const gate: UpdateGate = new UpdateGate(() => api.getClientPolicy(), client);
  const api = createApiClient({
    baseUrl: "http://192.168.1.10:3000",
    client,
    fetch: fetchImpl,
    onError: gate.handleApiError,
  });
  return { gate, api };
}

describe("update screen at start-up", () => {
  it("shows the update screen with the server's text when the version is below the minimum", async () => {
    const { gate } = appWith(
      vi
        .fn<FetchLike>()
        .mockResolvedValue(jsonResponse(200, policy("1.5.0", "1.0.0", "Жаңартыңыз"))),
    );

    const state = await gate.check();

    expect(shouldShowUpdateScreen(state)).toBe(true);
    expect(state).toEqual({ status: "update-required", message: "Жаңартыңыз" });
  });

  it("shows no update screen when the version is at or above the minimum", async () => {
    const { gate } = appWith(
      vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, policy("1.4.2", "9.0.0"))),
    );

    const state = await gate.check();

    expect(state).toEqual({ status: "supported" });
    expect(shouldShowUpdateScreen(state)).toBe(false);
  });

  it("shows no update screen when the server is unreachable", async () => {
    const { gate } = appWith(
      vi.fn<FetchLike>().mockRejectedValue(new TypeError("Network request failed")),
    );

    const state = await gate.check();

    expect(state).toEqual({ status: "unverified" });
    expect(shouldShowUpdateScreen(state)).toBe(false);
  });

  it("shows no update screen when the server answers with an error", async () => {
    const { gate } = appWith(
      vi
        .fn<FetchLike>()
        .mockResolvedValue(
          jsonResponse(500, { code: "INTERNAL_ERROR", message: "boom", retryable: true }),
        ),
    );

    expect(shouldShowUpdateScreen(await gate.check())).toBe(false);
  });

  it("applies the minimum of the phone's own platform", async () => {
    const both = policy("1.0.0", "2.0.0");
    const iosApp = appWith(vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, both)), ios);
    const androidApp = appWith(
      vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, both)),
      android,
    );

    expect((await iosApp.gate.check()).status).toBe("supported");
    expect((await androidApp.gate.check()).status).toBe("update-required");
  });

  it("does not block on a policy it can't read", async () => {
    const { gate } = appWith(
      vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { unexpected: true })),
    );

    expect((await gate.check()).status).toBe("unverified");
  });

  it("stays usable while the policy is loading", () => {
    const { gate } = appWith(() => new Promise(() => {}));

    void gate.check();

    expect(gate.getState()).toEqual({ status: "checking" });
    expect(shouldShowUpdateScreen(gate.getState())).toBe(false);
  });
});

describe("update screen while the app is open", () => {
  it("shows the update screen when any request is refused with CLIENT_UPDATE_REQUIRED", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, policy("1.0.0", "1.0.0")))
      .mockResolvedValueOnce(
        jsonResponse(426, {
          code: "CLIENT_UPDATE_REQUIRED",
          message: "Минимальная версия повышена",
          details: { platform: "ios", clientVersion: "1.4.2", minSupportedVersion: "1.5.0" },
          retryable: false,
        }),
      );
    const { gate, api } = appWith(fetchImpl);
    const listener = vi.fn();
    gate.subscribe(listener);

    expect((await gate.check()).status).toBe("supported");
    await expect(api.getReadiness()).rejects.toBeInstanceOf(ApiError);

    expect(gate.getState()).toEqual({
      status: "update-required",
      message: "Минимальная версия повышена",
    });
    expect(listener).toHaveBeenCalled();
  });

  it("ignores other API errors", () => {
    const { gate } = appWith(vi.fn());
    gate.handleApiError(
      new ApiError({ code: "NETWORK_ERROR", message: "offline", status: 0, retryable: true }),
    );
    expect(gate.getState()).toEqual({ status: "checking" });
  });

  it("keeps the update screen when 'check again' fails offline", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, policy("2.0.0", "2.0.0")))
      .mockRejectedValueOnce(new TypeError("Network request failed"));
    const { gate } = appWith(fetchImpl);

    await gate.check();
    const retried = await gate.check();

    expect(retried.status).toBe("update-required");
  });

  it("lifts the update screen when 'check again' finds the minimum lowered", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, policy("2.0.0", "2.0.0")))
      .mockResolvedValueOnce(jsonResponse(200, policy("1.0.0", "1.0.0")));
    const { gate } = appWith(fetchImpl);

    await gate.check();
    expect((await gate.check()).status).toBe("supported");
  });

  it("does not let a slower policy answer override a newer update-required signal", async () => {
    let resolvePolicy: (response: Response) => void = () => {};
    const { gate } = appWith(() => new Promise((resolve) => (resolvePolicy = resolve)));

    const pending = gate.check();
    gate.handleApiError(
      new ApiError({
        code: "CLIENT_UPDATE_REQUIRED",
        message: "Обновите",
        status: 426,
        retryable: false,
      }),
    );
    resolvePolicy(jsonResponse(200, policy("1.0.0", "1.0.0")));

    expect((await pending).status).toBe("update-required");
  });
});

describe("evaluateClientPolicy", () => {
  it("never blocks on an unparsable app version", () => {
    expect(
      evaluateClientPolicy(policy("9.9.9", "9.9.9"), { platform: "ios", version: "dev" }),
    ).toEqual({
      status: "supported",
    });
  });
});
