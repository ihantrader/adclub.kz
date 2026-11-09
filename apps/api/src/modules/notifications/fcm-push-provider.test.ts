import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FcmPushProvider,
  failureOf,
  signedAssertion,
  type FcmCredentials,
} from "./fcm-push-provider";
import { PushDeliveryError, type PushSendRequest } from "./push-provider";

/**
 * The real provider against a substituted `fetch` (TASK-051 AC-4): the
 * project has no Firebase project, so this is all that can be checked
 * before TASK-056.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const CREDENTIALS: FcmCredentials = {
  projectId: "adclub-test",
  clientEmail: "push@adclub-test.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  baseUrl: "https://fcm.example.test",
  tokenUrl: "https://oauth.example.test/token",
};

const REQUEST: PushSendRequest = {
  token: `device-instance:APA91b${"x".repeat(140)}`,
  platform: "android",
  body: "Автомаркет принял заявку: Колодки",
  data: {
    notificationId: "8d3f0a4c-7b1e-4d2a-9f3c-1e2d3c4b5a69",
    target: { screen: "order", params: { orderId: "1d2c3b4a-5e6f-4a1b-8c9d-0e1f2a3b4c5d" } },
  },
  collapseKey: "8d3f0a4c-7b1e-4d2a-9f3c-1e2d3c4b5a69",
};

interface Call {
  url: string;
  init: RequestInit;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function provider(
  answers: ((call: Call) => Response | Promise<Response>)[],
  now: () => number = Date.now,
) {
  const calls: Call[] = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error(`Unexpected call ${url}`);
    return Promise.resolve(answer({ url, init }));
  };
  return { fcm: new FcmPushProvider(CREDENTIALS, fetch, now), calls };
}

const token =
  (value = "ya29.access", expiresIn = 3600) =>
  () =>
    json(200, { access_token: value, expires_in: expiresIn, token_type: "Bearer" });
const sent = () => () => json(200, { name: "projects/adclub-test/messages/0:1700000000%abc" });

async function failureKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "none";
  } catch (error) {
    return error instanceof PushDeliveryError ? error.kind : "other";
  }
}

describe("FcmPushProvider (FCM HTTP v1)", () => {
  it("exchanges a signed assertion for a token, then sends the message of SCREENS 8.4", async () => {
    const { fcm, calls } = provider([token(), sent()]);
    const result = await fcm.send(REQUEST, new AbortController().signal);
    expect(result.providerMessageId).toBe("projects/adclub-test/messages/0:1700000000%abc");

    expect(calls[0]!.url).toBe(CREDENTIALS.tokenUrl);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    const decoded = JSON.parse(Buffer.from(claims!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    expect(decoded).toMatchObject({
      iss: CREDENTIALS.clientEmail,
      aud: CREDENTIALS.tokenUrl,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });

    expect(calls[1]!.url).toBe("https://fcm.example.test/v1/projects/adclub-test/messages:send");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer ya29.access",
    );
    const message = (
      JSON.parse(String(calls[1]!.init.body)) as { message: Record<string, unknown> }
    ).message;
    // Data only (TASK-056): `expo-notifications` draws it and runs the background task.
    expect(message).toEqual({
      token: REQUEST.token,
      data: {
        message: REQUEST.body,
        channelId: "default",
        notificationId: REQUEST.data.notificationId,
        target: JSON.stringify(REQUEST.data.target),
      },
      android: { priority: "high", collapse_key: REQUEST.collapseKey },
    });
    expect(message).not.toHaveProperty("notification");
  });

  it("reuses the token until shortly before it expires, then exchanges a new one", async () => {
    let now = 1_700_000_000_000;
    const { fcm, calls } = provider(
      [token("first"), sent(), sent(), token("second"), sent()],
      () => now,
    );
    await fcm.send(REQUEST, new AbortController().signal);
    now += 30 * 60_000;
    await fcm.send(REQUEST, new AbortController().signal);
    // 56 minutes later: within the five minutes of early renewal.
    now += 26 * 60_000;
    await fcm.send(REQUEST, new AbortController().signal);
    expect(calls.map((call) => call.url.includes("token"))).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    expect((calls[4]!.init.headers as Record<string, string>).authorization).toBe("Bearer second");
  });

  it("forgets a token FCM refused (401) and treats it as not sent", async () => {
    const { fcm, calls } = provider([
      token("stale"),
      () =>
        json(401, {
          error: {
            code: 401,
            status: "UNAUTHENTICATED",
            message: "Request had invalid authentication",
          },
        }),
      token("fresh"),
      sent(),
    ]);
    expect(await failureKind(fcm.send(REQUEST, new AbortController().signal))).toBe("unavailable");
    await fcm.send(REQUEST, new AbortController().signal);
    expect((calls[3]!.init.headers as Record<string, string>).authorization).toBe("Bearer fresh");
  });

  it("reads the outcomes FCM documents", async () => {
    const error =
      (status: number, errorCode: string, message = "") =>
      () =>
        json(status, {
          error: {
            code: status,
            status: errorCode,
            message,
            details: [
              { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode },
            ],
          },
        });
    const cases: [() => Response, string][] = [
      [error(404, "UNREGISTERED", "Requested entity was not found."), "invalid_token"],
      // A 404 of the project path (a wrong `FCM_PROJECT_ID`), not of the token.
      [
        () =>
          json(404, {
            error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." },
          }),
        "rejected",
      ],
      [error(403, "SENDER_ID_MISMATCH"), "invalid_token"],
      [
        error(
          400,
          "INVALID_ARGUMENT",
          "The registration token is not a valid FCM registration token",
        ),
        "invalid_token",
      ],
      [error(400, "INVALID_ARGUMENT", "Invalid value at 'message.data'"), "rejected"],
      [error(429, "QUOTA_EXCEEDED"), "unavailable"],
      [error(503, "UNAVAILABLE"), "unavailable"],
      [error(500, "INTERNAL"), "unavailable"],
      [error(401, "THIRD_PARTY_AUTH_ERROR"), "rejected"],
      [() => json(200, {}), "unknown"],
    ];
    for (const [answer, kind] of cases) {
      const { fcm } = provider([token(), answer]);
      expect(await failureKind(fcm.send(REQUEST, new AbortController().signal))).toBe(kind);
    }
  });

  it("calls a connection never made «unavailable» and one that dropped «unknown»", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const dropped = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_SOCKET" },
    });
    const never = provider([token(), () => Promise.reject(refused)]);
    expect(await failureKind(never.fcm.send(REQUEST, new AbortController().signal))).toBe(
      "unavailable",
    );
    const lost = provider([token(), () => Promise.reject(dropped)]);
    expect(await failureKind(lost.fcm.send(REQUEST, new AbortController().signal))).toBe("unknown");
    // Getting a token sends nothing: any failure there is «not sent».
    const noToken = provider([() => Promise.reject(dropped)]);
    expect(await failureKind(noToken.fcm.send(REQUEST, new AbortController().signal))).toBe(
      "unavailable",
    );
  });

  it("never puts the token or the text into an error", async () => {
    const { fcm } = provider([
      token(),
      () => json(400, { error: { status: "INVALID_ARGUMENT", message: "bad" } }),
    ]);
    try {
      await fcm.send(REQUEST, new AbortController().signal);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("APA91b");
      expect(String((error as Error).message)).not.toContain("Колодки");
    }
    expect(failureOf(500, undefined).kind).toBe("unavailable");
    expect(signedAssertion(CREDENTIALS, 1).split(".")).toHaveLength(3);
  });
});
