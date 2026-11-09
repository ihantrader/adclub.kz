import { createPrivateKey, createSign } from "node:crypto";
import {
  connect,
  constants,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
  type SecureClientSessionOptions,
} from "node:http2";
import {
  PushDeliveryError,
  PushProvider,
  type PushChannelName,
  type PushFailureKind,
  type PushSendRequest,
  type PushSendResult,
} from "./push-provider";

/**
 * Apple Push Notification service directly, behind `PushProvider`
 * (TASK-056, ARCHITECTURE 4.81; the choice of I866): an iPhone's token from
 * `getDevicePushTokenAsync` is an APNs token, which FCM HTTP v1 does not
 * take, and a Firebase SDK in the iOS build only to translate it would be one
 * more link. `node:http2` and `node:crypto` are enough, the same choice as
 * FCM (I854): `POST /3/device/<token>` over one reused HTTP/2 connection,
 * authorised by a provider token (JWT ES256 of the team's `.p8` key).
 *
 * **Nothing here has ever reached Apple.** The project has no Apple
 * Developer account yet (TASK-056 part B): this is written from Apple's
 * documentation («Sending notification requests to APNs», «Handling
 * notification responses from APNs») and exercised against a local HTTP/2
 * server in tests. Failures are classified by the documented `reason`.
 */

export const APNS_ORIGINS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

export type ApnsEnvironment = keyof typeof APNS_ORIGINS;

export interface ApnsCredentials {
  /** The `.p8` key's id (10 characters). */
  keyId: string;
  /** The Apple Developer team (10 characters). */
  teamId: string;
  /** PEM of the `.p8` key (PKCS #8, P-256). */
  privateKey: string;
  /** The app's bundle identifier: the `apns-topic`. */
  bundleId: string;
  environment: ApnsEnvironment;
  /** Where APNs is; `APNS_ORIGINS[environment]` unless development (or a test) says otherwise. */
  origin?: string;
}

export interface ApnsOptions {
  /** TLS options of the connection — a test trusts its own certificate here. */
  connectOptions?: SecureClientSessionOptions;
  /** How long an idle connection stays open (Apple asks to keep it, not to reopen per push). */
  idleMs?: number;
  /** How long APNs keeps trying to deliver a push to an offline device. */
  expirationSeconds?: number;
  now?: () => number;
}

/**
 * A provider token is reused for 50 minutes: Apple refuses one older than an
 * hour (`ExpiredProviderToken`) and one renewed more often than every 20
 * minutes (`TooManyProviderTokenUpdates`).
 */
export const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60_000;

/**
 * An idle connection is closed after two minutes — well under what cloud NATs
 * and balancers silently drop (~350 s): a half-open socket would turn the
 * next push into `unknown`, which is never retried by itself.
 */
const DEFAULT_IDLE_MS = 2 * 60_000;

/** An APNs device token: hex, 32 bytes today, longer allowed (Apple says not to assume a length). */
const DEVICE_TOKEN = /^[0-9a-fA-F]{64,200}$/;
/** A day: an order's push is not news a day later (the WhatsApp copy has gone by then, 4.80). */
const DEFAULT_EXPIRATION_S = 24 * 3600;

/** The documented `reason`s and what they mean for one delivery. */
const FAILURE_BY_REASON: Readonly<Record<string, PushFailureKind>> = {
  BadDeviceToken: "invalid_token",
  Unregistered: "invalid_token",
  ExpiredToken: "invalid_token",
  // The token does not belong to our topic: the bundle id in `APNS_BUNDLE_ID`
  // is wrong, or a sandbox build talks to a production server. That is our
  // configuration, not a dead device — treating it as one would switch every
  // iPhone off until its next cold start (review at the acceptance, I894).
  DeviceTokenNotForTopic: "rejected",
  TooManyRequests: "unavailable",
  InternalServerError: "unavailable",
  ServiceUnavailable: "unavailable",
  Shutdown: "unavailable",
  // The request itself is wrong: a person fixes the configuration.
  BadTopic: "rejected",
  MissingTopic: "rejected",
  TopicDisallowed: "rejected",
  PayloadTooLarge: "rejected",
  PayloadEmpty: "rejected",
  BadCollapseId: "rejected",
  BadExpirationDate: "rejected",
  BadPriority: "rejected",
  BadPushType: "rejected",
  InvalidPushType: "rejected",
  InvalidProviderToken: "rejected",
  ExpiredProviderToken: "rejected",
  MissingProviderToken: "rejected",
  BadCertificate: "rejected",
  BadCertificateEnvironment: "rejected",
  Forbidden: "rejected",
  TooManyProviderTokenUpdates: "unavailable",
};

/** A 403 that a fresh provider token may cure — tried once more after renewing it. */
const RENEWABLE = new Set(["InvalidProviderToken", "ExpiredProviderToken"]);

/** Connections whose TLS handshake finished: a request on them may have reached Apple. */
const CONNECTED = new WeakSet<ClientHttp2Session>();

interface ApnsAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  reason: string | undefined;
}

export class ApnsPushProvider extends PushProvider {
  private session: ClientHttp2Session | null = null;
  private providerToken: { value: string; renewAt: number } | null = null;
  private readonly origin: string;
  private readonly now: () => number;

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly options: ApnsOptions = {},
  ) {
    super();
    this.origin = (credentials.origin ?? APNS_ORIGINS[credentials.environment]).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    // A key that cannot sign is a configuration error: the process refuses to
    // start, instead of every push looking like an outage of Apple. The key
    // must be the P-256 one of the `.p8` file: any other key signs too, but
    // Apple then refuses every token as `InvalidProviderToken` (I894).
    let keyType: string | undefined;
    let curve: string | undefined;
    try {
      const key = createPrivateKey(credentials.privateKey);
      keyType = key.asymmetricKeyType;
      curve = key.asymmetricKeyDetails?.namedCurve;
      this.token();
    } catch (error) {
      throw new Error("APNS_PRIVATE_KEY cannot sign a provider token (is it the .p8 key, PEM?)", {
        cause: error,
      });
    }
    if (keyType !== "ec" || curve !== "prime256v1") {
      throw new Error(
        `APNS_PRIVATE_KEY is a ${keyType ?? "?"}${curve ? ` ${curve}` : ""} key, not the P-256 (ES256) key of the .p8 file`,
      );
    }
  }

  providerFor(): PushChannelName {
    return "apns";
  }

  async send(request: PushSendRequest, signal: AbortSignal): Promise<PushSendResult> {
    // The token goes into the request's path: anything but hex is no APNs
    // token (and must not rewrite the path we sign with our key).
    if (!DEVICE_TOKEN.test(request.token)) {
      throw new PushDeliveryError("invalid_token", "The device token is not an APNs token");
    }
    let answer = await this.post(request, signal);
    if (answer.status === 403 && answer.reason && RENEWABLE.has(answer.reason)) {
      // Our token was refused: nothing was delivered. Once more with a new one.
      this.providerToken = null;
      answer = await this.post(request, signal);
    }
    if (answer.status === 200) {
      const id = answer.headers["apns-id"];
      if (typeof id !== "string" || id === "") {
        throw new PushDeliveryError("unknown", "APNs answered 200 without an apns-id");
      }
      return { providerMessageId: id };
    }
    throw failureOf(answer.status, answer.reason);
  }

  /** Closes the connection (the worker's shutdown; the tests). */
  close(): void {
    const session = this.session;
    this.session = null;
    session?.close();
  }

  /** The provider token, signed again when there is none or it is 50 minutes old. */
  private token(): string {
    if (this.providerToken && this.now() < this.providerToken.renewAt) {
      return this.providerToken.value;
    }
    const value = providerTokenOf(this.credentials, Math.floor(this.now() / 1000));
    this.providerToken = { value, renewAt: this.now() + PROVIDER_TOKEN_LIFETIME_MS };
    return value;
  }

  /** The connection to APNs, opened when there is none (or the last one closed). */
  private connection(): ClientHttp2Session {
    const current = this.session;
    if (current && !current.closed && !current.destroyed) return current;
    const session = connect(this.origin, this.options.connectOptions);
    session.setTimeout(this.options.idleMs ?? DEFAULT_IDLE_MS, () => {
      if (this.session === session) this.session = null;
      session.close();
    });
    session.once("connect", () => CONNECTED.add(session));
    const forget = () => {
      if (this.session === session) this.session = null;
    };
    session.on("goaway", forget);
    session.on("close", forget);
    // A failed connection reaches the stream as its error; the session's own
    // event must not crash the process.
    session.on("error", forget);
    // The worker must be able to exit while a connection idles.
    session.unref();
    this.session = session;
    return session;
  }

  private post(request: PushSendRequest, signal: AbortSignal): Promise<ApnsAnswer> {
    if (signal.aborted) {
      return Promise.reject(
        signal.reason instanceof PushDeliveryError
          ? signal.reason
          : new PushDeliveryError("unavailable", "The send was cancelled before reaching APNs"),
      );
    }
    const session = this.connection();
    const nowS = Math.floor(this.now() / 1000);
    return new Promise<ApnsAnswer>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: ApnsAnswer | PushDeliveryError) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (outcome instanceof PushDeliveryError) reject(outcome);
        else resolve(outcome);
      };
      // Whether the connection was made: after it, a failure may have been delivered.
      const lost = (what: string, error?: unknown) =>
        CONNECTED.has(session)
          ? new PushDeliveryError("unknown", `${what}, and APNs may have taken the request`, {
              cause: error,
            })
          : new PushDeliveryError("unavailable", "APNs could not be reached", { cause: error });

      let stream: ReturnType<ClientHttp2Session["request"]>;
      try {
        stream = session.request({
          [constants.HTTP2_HEADER_METHOD]: "POST",
          [constants.HTTP2_HEADER_PATH]: `/3/device/${request.token}`,
          authorization: `bearer ${this.token()}`,
          "apns-topic": this.credentials.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-collapse-id": request.collapseKey,
          "apns-expiration": String(
            nowS + (this.options.expirationSeconds ?? DEFAULT_EXPIRATION_S),
          ),
          "content-type": "application/json",
        });
      } catch (error) {
        finish(new PushDeliveryError("unavailable", "APNs could not be reached", { cause: error }));
        return;
      }

      function onAbort() {
        stream.close(constants.NGHTTP2_CANCEL);
        finish(
          signal.reason instanceof PushDeliveryError
            ? signal.reason
            : lost("The request to APNs was aborted"),
        );
      }
      signal.addEventListener("abort", onAbort, { once: true });

      let status = 0;
      let headers: IncomingHttpHeaders = {};
      const chunks: Buffer[] = [];
      stream.on("response", (answer) => {
        headers = answer;
        status = Number(answer[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        if (status === 0) {
          finish(lost("The connection to APNs ended without an answer"));
          return;
        }
        finish({ status, headers, reason: reasonOf(Buffer.concat(chunks).toString("utf8")) });
      });
      // A stream reset without an error (RST_STREAM NO_ERROR) or closed before
      // its end: settled here instead of waiting for the job's limit.
      stream.on("close", () => finish(lost("The stream to APNs closed without an answer")));
      stream.on("error", (error) => {
        // A stream APNs refused before processing it was not delivered.
        const code = (error as { code?: unknown }).code;
        if (code === "ERR_HTTP2_STREAM_ERROR" && /REFUSED_STREAM/.test(String(error))) {
          finish(new PushDeliveryError("unavailable", "APNs refused the stream", { cause: error }));
          return;
        }
        finish(lost("The connection to APNs failed", error));
      });
      stream.end(JSON.stringify(payloadOf(request)));
    });
  }
}

/**
 * The APNs payload of one delivery: the text, a sound, `content-available`
 * so iOS may wake the app to confirm the push in the background (TASK-056
 * requirement 4), and the data the app opens. The data is written both at the
 * top level and under `body`, the key `expo-notifications` reads a remote
 * push's data from on iOS — either reading finds `notificationId` and
 * `target` (a JSON string, as FCM data values are).
 */
export function payloadOf(request: PushSendRequest): Record<string, unknown> {
  const data = {
    notificationId: request.data.notificationId,
    target: JSON.stringify(request.data.target),
  };
  return {
    aps: { alert: { body: request.body }, sound: "default", "content-available": 1 },
    ...data,
    body: data,
  };
}

/** The provider token: a JWT ES256 of the key, `iss` — the team, `iat` — now (seconds). */
export function providerTokenOf(
  credentials: Pick<ApnsCredentials, "keyId" | "teamId" | "privateKey">,
  nowS: number,
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }));
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: nowS }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign({ key: credentials.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

/** What an error answer of APNs means: the documented `reason` first, then the status. */
export function failureOf(status: number, reason: string | undefined): PushDeliveryError {
  let kind: PushFailureKind;
  if (status === 410) {
    kind = "invalid_token";
  } else if (reason && FAILURE_BY_REASON[reason]) {
    kind = FAILURE_BY_REASON[reason];
  } else if (status === 429 || status >= 500) {
    kind = "unavailable";
  } else {
    kind = "rejected";
  }
  return new PushDeliveryError(
    kind,
    `APNs answered ${String(status)}${reason ? ` ${reason}` : ""}`,
  );
}

function reasonOf(text: string): string | undefined {
  if (text.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(text) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
