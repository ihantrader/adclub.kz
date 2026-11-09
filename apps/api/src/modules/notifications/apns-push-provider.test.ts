import { spawnSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createSecureServer,
  type Http2SecureServer,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ApnsPushProvider,
  failureOf,
  payloadOf,
  PROVIDER_TOKEN_LIFETIME_MS,
  providerTokenOf,
  type ApnsCredentials,
} from "./apns-push-provider";
import { PlatformPushRouter } from "./platform-push-router";
import {
  PushDeliveryError,
  PushProvider,
  type PushChannelName,
  type PushSendRequest,
  type PushSendResult,
} from "./push-provider";

/**
 * The real APNs provider against a local HTTP/2 server with a self-signed
 * certificate made for the test (TASK-056 AC-3): the project has no Apple
 * Developer account, so this is all that can be checked before part B.
 */

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

const REQUEST: PushSendRequest = {
  token: "a1b2c3d4e5f6".repeat(5) + "abcd",
  platform: "ios",
  body: "Автомаркет принял заявку: Колодки",
  data: {
    notificationId: "8d3f0a4c-7b1e-4d2a-9f3c-1e2d3c4b5a69",
    target: { screen: "order", params: { orderId: "1d2c3b4a-5e6f-4a1b-8c9d-0e1f2a3b4c5d" } },
  },
  collapseKey: "8d3f0a4c-7b1e-4d2a-9f3c-1e2d3c4b5a69",
};

/** `openssl` of the machine: on Linux (CI) in the path, on Windows — the one of Git for Windows. */
function openssl(): string {
  for (const candidate of [
    "openssl",
    "C:/Program Files/Git/usr/bin/openssl.exe",
    "C:/Program Files/Git/mingw64/bin/openssl.exe",
  ]) {
    if (candidate === "openssl" || existsSync(candidate)) {
      const probe = spawnSync(candidate, ["version"], { encoding: "utf8" });
      if (probe.status === 0) return candidate;
    }
  }
  throw new Error("openssl is needed to make the test's certificate");
}

/** A certificate for 127.0.0.1, made now and trusted by the provider only. */
function selfSignedCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "apns-test-"));
  try {
    const result = spawnSync(
      openssl(),
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
    );
    if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

type Answer = (stream: ServerHttp2Stream, received: Received) => void;

let tls: { key: string; cert: string };
let server: Http2SecureServer;
let port: number;
let answers: Answer[] = [];
let received: Received[] = [];
let connections = 0;
const providers: ApnsPushProvider[] = [];

beforeAll(async () => {
  tls = selfSignedCertificate();
  server = createSecureServer({ key: tls.key, cert: tls.cert });
  server.on("session", () => (connections += 1));
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const call = { headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(call);
      const answer = answers.shift();
      if (!answer) {
        stream.respond({ ":status": 500 });
        stream.end();
        return;
      }
      answer(stream, call);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(() => {
  for (const provider of providers.splice(0)) provider.close();
  answers = [];
  received = [];
  connections = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function credentials(origin = `https://127.0.0.1:${String(port)}`): ApnsCredentials {
  return {
    keyId: "ABC123DEFG",
    teamId: "TEAM123456",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    bundleId: "kz.adclub.app",
    environment: "sandbox",
    origin,
  };
}

function apns(options: { now?: () => number; origin?: string } = {}): ApnsPushProvider {
  const provider = new ApnsPushProvider(credentials(options.origin), {
    connectOptions: { ca: tls.cert },
    ...(options.now ? { now: options.now } : {}),
  });
  providers.push(provider);
  return provider;
}

function ok(id = "5a1b2c3d-0000-4000-8000-000000000001"): Answer {
  return (stream) => {
    stream.respond({ ":status": 200, "apns-id": id });
    stream.end();
  };
}

function error(status: number, reason?: string): Answer {
  return (stream) => {
    stream.respond({ ":status": status, "content-type": "application/json" });
    stream.end(reason ? JSON.stringify({ reason }) : "");
  };
}

/** Takes the request and never answers: the send times out after the headers went. */
const silence: Answer = () => undefined;

const signal = () => new AbortController().signal;

async function failure(promise: Promise<unknown>): Promise<PushDeliveryError> {
  try {
    await promise;
  } catch (caught) {
    expect(caught).toBeInstanceOf(PushDeliveryError);
    return caught as PushDeliveryError;
  }
  throw new Error("Expected the send to fail");
}

function claimsOf(authorization: unknown): { header: unknown; claims: unknown } {
  const [header, claims] = String(authorization)
    .replace(/^bearer /, "")
    .split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString("utf8")),
  };
}

describe("ApnsPushProvider (TASK-056, ARCHITECTURE 4.81)", () => {
  it("sends with the documented headers and payload and takes the apns-id", async () => {
    answers.push(ok("apns-id-1"));
    const now = 1_700_000_000_000;
    const result = await apns({ now: () => now }).send(REQUEST, signal());

    expect(result).toEqual({ providerMessageId: "apns-id-1" });
    const [call] = received;
    expect(call!.headers[":method"]).toBe("POST");
    expect(call!.headers[":path"]).toBe(`/3/device/${REQUEST.token}`);
    expect(call!.headers["apns-topic"]).toBe("kz.adclub.app");
    expect(call!.headers["apns-push-type"]).toBe("alert");
    expect(call!.headers["apns-priority"]).toBe("10");
    expect(call!.headers["apns-collapse-id"]).toBe(REQUEST.collapseKey);
    expect(call!.headers["apns-expiration"]).toBe(String(now / 1000 + 24 * 3600));
    expect(claimsOf(call!.headers.authorization)).toEqual({
      header: { alg: "ES256", kid: "ABC123DEFG" },
      claims: { iss: "TEAM123456", iat: now / 1000 },
    });
    const body = JSON.parse(call!.body) as Record<string, unknown>;
    expect(body).toEqual(payloadOf(REQUEST));
    expect(body.aps).toEqual({
      alert: { body: REQUEST.body },
      sound: "default",
      "content-available": 1,
    });
    // The data as FCM has it, at the top and under `body` (expo-notifications on iOS).
    const data = {
      notificationId: REQUEST.data.notificationId,
      target: JSON.stringify(REQUEST.data.target),
    };
    expect(body).toMatchObject({ ...data, body: data });
  });

  it("signs a provider token Apple can verify (ES256, P-256)", () => {
    const token = providerTokenOf(credentials(), 1_700_000_000);
    const [header, claims, signature] = token.split(".");
    const verifier = createVerify("SHA256");
    verifier.update(`${header}.${claims}`);
    expect(
      verifier.verify(
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    // 64 bytes: r and s, not DER.
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
  });

  it("reuses the provider token and the connection, and renews the token after 50 minutes", async () => {
    let now = 1_700_000_000_000;
    const provider = apns({ now: () => now });
    answers.push(ok(), ok(), ok());
    await provider.send(REQUEST, signal());
    now += PROVIDER_TOKEN_LIFETIME_MS - 1000;
    await provider.send(REQUEST, signal());
    now += 2000;
    await provider.send(REQUEST, signal());
    const tokens = received.map((call) => call.headers.authorization);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
    expect(connections).toBe(1);
  });

  it("sends concurrent pushes over one connection with one provider token", async () => {
    const provider = apns();
    answers.push(ok("a"), ok("b"), ok("c"));
    const results = await Promise.all([1, 2, 3].map(() => provider.send(REQUEST, signal())));
    expect(results.map((result) => result.providerMessageId).sort()).toEqual(["a", "b", "c"]);
    expect(new Set(received.map((call) => call.headers.authorization)).size).toBe(1);
    expect(connections).toBe(1);
  });

  it("410 Unregistered and BadDeviceToken are a dead token", async () => {
    answers.push(error(410, "Unregistered"));
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("invalid_token");
    answers.push(error(400, "BadDeviceToken"));
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("invalid_token");
  });

  it("DeviceTokenNotForTopic is our configuration, not a dead token (I894)", async () => {
    // A wrong APNS_BUNDLE_ID or a sandbox build against a production server
    // must not deactivate every iPhone until its next cold start.
    answers.push(error(400, "DeviceTokenNotForTopic"));
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("rejected");
  });

  it("429 and 503 are «try again later»", async () => {
    answers.push(error(429, "TooManyRequests"));
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("unavailable");
    answers.push(error(503, "ServiceUnavailable"));
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("unavailable");
    answers.push(error(500));
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("unavailable");
  });

  it("403 InvalidProviderToken is tried once more with a new token, then rejected", async () => {
    let now = 1_700_000_000_000;
    const provider = apns({ now: () => now });
    answers.push(error(403, "InvalidProviderToken"), ok("after-renewal"));
    expect(await provider.send(REQUEST, signal())).toEqual({ providerMessageId: "after-renewal" });
    expect(received).toHaveLength(2);

    now += 1000;
    answers.push(error(403, "InvalidProviderToken"), error(403, "InvalidProviderToken"));
    const refused = await failure(provider.send(REQUEST, signal()));
    expect(refused.kind).toBe("rejected");
    expect(refused.message).toBe("APNs answered 403 InvalidProviderToken");
    // One renewal per send, not a loop.
    expect(received).toHaveLength(4);
  });

  it("400 about the request is rejected for good", async () => {
    for (const reason of ["BadTopic", "PayloadTooLarge", "MissingTopic"]) {
      answers.push(error(400, reason));
      expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("rejected");
    }
  });

  it("200 without an apns-id is unknown", async () => {
    answers.push((stream) => {
      stream.respond({ ":status": 200 });
      stream.end();
    });
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("unknown");
  });

  it("a timeout after the request was sent is unknown — APNs may have taken it", async () => {
    answers.push(silence);
    const controller = new AbortController();
    const sending = apns().send(REQUEST, controller.signal);
    await vitestWaitFor(() => received.length === 1);
    controller.abort();
    const lost = await failure(sending);
    expect(lost.kind).toBe("unknown");
  });

  it("a connection dropped after the request went is unknown", async () => {
    answers.push((stream) => stream.session?.destroy());
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("unknown");
  });

  it("a connection never made is unavailable — nothing was sent", async () => {
    // A port nobody listens on.
    const closed = createSecureServer({ key: tls.key, cert: tls.cert });
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const freePort = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const provider = apns({ origin: `https://127.0.0.1:${String(freePort)}` });
    expect((await failure(provider.send(REQUEST, signal()))).kind).toBe("unavailable");
  });

  it("an untrusted certificate is unavailable, not unknown", async () => {
    const provider = new ApnsPushProvider(credentials());
    providers.push(provider);
    expect((await failure(provider.send(REQUEST, signal()))).kind).toBe("unavailable");
  });

  it("a stream reset without an error settles at once as unknown", async () => {
    answers.push((stream) => stream.close(0));
    const started = Date.now();
    expect((await failure(apns().send(REQUEST, signal()))).kind).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a token that is not APNs hex is dead and never reaches the path", async () => {
    const lost = await failure(
      apns().send({ ...REQUEST, token: "../../3/device/x?y=1#zzzzzzz" }, signal()),
    );
    expect(lost.kind).toBe("invalid_token");
    expect(received).toHaveLength(0);
  });

  it("refuses to start with a key that cannot sign", () => {
    expect(
      () =>
        new ApnsPushProvider({
          ...credentials(),
          privateKey: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(120)}\n-----END PRIVATE KEY-----\n`,
        }),
    ).toThrow(/APNS_PRIVATE_KEY cannot sign/);
  });

  it("refuses to start with a key that signs but is not P-256 (I894)", () => {
    // An RSA key signs a token too — Apple then answers InvalidProviderToken
    // to every push, which would look like a broken configuration at runtime
    // instead of at start.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    expect(() => new ApnsPushProvider({ ...credentials(), privateKey: rsa })).toThrow(
      /is a rsa key, not the P-256/,
    );
  });

  it("never puts the device token or the text in a failure message", async () => {
    answers.push(error(400, "BadTopic"));
    const refused = await failure(apns().send(REQUEST, signal()));
    expect(refused.message).not.toContain(REQUEST.token);
    expect(refused.message).not.toContain(REQUEST.body);
  });

  it("classifies by the documented reason first, then by the status", () => {
    expect(failureOf(410, undefined).kind).toBe("invalid_token");
    expect(failureOf(400, "ExpiredToken").kind).toBe("invalid_token");
    expect(failureOf(503, "Shutdown").kind).toBe("unavailable");
    expect(failureOf(403, "ExpiredProviderToken").kind).toBe("rejected");
    expect(failureOf(404, "BadPath").kind).toBe("rejected");
    expect(failureOf(502, undefined).kind).toBe("unavailable");
  });
});

describe("PlatformPushRouter (TASK-056)", () => {
  class Recorder extends PushProvider {
    readonly sent: PushSendRequest[] = [];
    constructor(private readonly name: PushChannelName) {
      super();
    }
    providerFor(): PushChannelName {
      return this.name;
    }
    send(request: PushSendRequest): Promise<PushSendResult> {
      this.sent.push(request);
      return Promise.resolve({ providerMessageId: this.name });
    }
  }

  it("sends an iPhone's push to APNs and an Android's to FCM", async () => {
    const fcm = new Recorder("fcm");
    const apnsProvider = new Recorder("apns");
    const router = new PlatformPushRouter({ android: fcm, ios: apnsProvider });
    expect(await router.send({ ...REQUEST, platform: "ios" }, signal())).toEqual({
      providerMessageId: "apns",
    });
    expect(await router.send({ ...REQUEST, platform: "android" }, signal())).toEqual({
      providerMessageId: "fcm",
    });
    expect(apnsProvider.sent.map((request) => request.platform)).toEqual(["ios"]);
    expect(fcm.sent.map((request) => request.platform)).toEqual(["android"]);
    expect(router.providerFor("ios")).toBe("apns");
    expect(router.providerFor("android")).toBe("fcm");
  });
});

async function vitestWaitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error("The condition was not met in time");
}
