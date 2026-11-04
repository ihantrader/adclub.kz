import { createSign } from "node:crypto";
import { z } from "zod";
import {
  PushDeliveryError,
  PushProvider,
  type PushFailureKind,
  type PushSendRequest,
  type PushSendResult,
} from "./push-provider";

/**
 * Firebase Cloud Messaging HTTP v1 behind `PushProvider` (ARCHITECTURE 9.3,
 * 4.79): Android directly, iOS through APNs, one request per device —
 * `POST /v1/projects/{project}/messages:send` with an OAuth2 access token of
 * the project's service account. Plain `fetch` and `node:crypto` are enough,
 * so the project carries no Firebase SDK (the choice of the AI gateway and
 * the WhatsApp channel, 4.20 I185).
 *
 * **Nothing here has ever been called.** The project has no Firebase project
 * yet (the live check is TASK-056): this file is written from Google's
 * documentation and exercised against a substituted `fetch` in tests.
 * Failures are classified by FCM's documented `errorCode`, not its wording.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  /** PEM of the service account's RSA key. */
  privateKey: string;
  /** `https://fcm.googleapis.com`. */
  baseUrl: string;
  /** `https://oauth2.googleapis.com/token`. */
  tokenUrl: string;
}

/** The scope FCM HTTP v1 asks for. */
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** An access token is used until this long before Google says it expires. */
const TOKEN_EARLY_RENEWAL_MS = 5 * 60_000;

/** How long the signed assertion is valid (Google allows one hour at most). */
const ASSERTION_LIFETIME_S = 3600;

const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const errorAnswerSchema = z.object({
  error: z
    .object({
      code: z.number().optional(),
      status: z.string().optional(),
      message: z.string().optional(),
      details: z
        .array(
          z.object({ "@type": z.string().optional(), errorCode: z.string().optional() }).loose(),
        )
        .optional(),
    })
    .optional(),
});

const sentAnswerSchema = z.object({ name: z.string().min(1) });

/**
 * FCM's documented error codes (`FcmError.ErrorCode`) and what they mean for
 * one delivery. `INVALID_ARGUMENT` alone is decided by its wording — FCM uses
 * it for a malformed token and for a malformed message alike.
 */
const FAILURE_BY_ERROR_CODE: Readonly<Record<string, PushFailureKind>> = {
  UNREGISTERED: "invalid_token",
  // The token belongs to another Firebase project: for us it is dead.
  SENDER_ID_MISMATCH: "invalid_token",
  QUOTA_EXCEEDED: "unavailable",
  UNAVAILABLE: "unavailable",
  INTERNAL: "unavailable",
  // APNs or the web push service refused our certificate or key: a person fixes it.
  THIRD_PARTY_AUTH_ERROR: "rejected",
};

export class FcmPushProvider extends PushProvider {
  readonly provider = "fcm" as const;
  private accessToken: { value: string; renewAt: number } | null = null;
  /** One exchange at a time: concurrent sends wait for the same token. */
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly credentials: FcmCredentials,
    private readonly fetch: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  async send(request: PushSendRequest, signal: AbortSignal): Promise<PushSendResult> {
    const bearer = await this.token(signal);
    const response = await this.call(
      `${this.credentials.baseUrl}/v1/projects/${this.credentials.projectId}/messages:send`,
      {
        method: "POST",
        signal,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ message: messageOf(request) }),
      },
      signal,
      true,
    );
    const parsed = safeJson(await response.text());
    if (!response.ok) {
      if (response.status === 401) {
        // The access token was refused (revoked, the clock): the next send
        // exchanges a new one. Nothing was sent.
        this.accessToken = null;
      }
      throw failureOf(response.status, errorAnswerSchema.safeParse(parsed).data?.error);
    }
    const sent = sentAnswerSchema.safeParse(parsed);
    if (!sent.success) {
      // A 200 without the message's name: it probably went, nobody can tell.
      throw new PushDeliveryError("unknown", "FCM answered 200 without a message name");
    }
    return { providerMessageId: sent.data.name };
  }

  /** The access token, exchanged for a signed assertion when there is none or it is about to end. */
  private async token(signal: AbortSignal): Promise<string> {
    if (this.accessToken && this.now() < this.accessToken.renewAt) {
      return this.accessToken.value;
    }
    this.pendingToken ??= this.exchange(signal).finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async exchange(signal: AbortSignal): Promise<string> {
    const nowS = Math.floor(this.now() / 1000);
    const assertion = signedAssertion(this.credentials, nowS);
    const response = await this.call(
      this.credentials.tokenUrl,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      },
      signal,
      // Getting a token sends nothing to anybody: any failure here is "not sent".
      false,
    );
    const parsed = tokenAnswerSchema.safeParse(safeJson(await response.text()));
    if (!response.ok || !parsed.success) {
      throw new PushDeliveryError(
        response.status >= 500 || response.status === 429 ? "unavailable" : "rejected",
        `Google's token endpoint answered ${String(response.status)}`,
      );
    }
    this.accessToken = {
      value: parsed.data.access_token,
      renewAt: this.now() + parsed.data.expires_in * 1000 - TOKEN_EARLY_RENEWAL_MS,
    };
    return parsed.data.access_token;
  }

  /**
   * One HTTP call. A connection never made is `unavailable`; anything else
   * that fails on the way (a timeout, an abort, a dropped connection) is
   * `unknown` for a send — FCM may have taken it — and `unavailable` for the
   * token exchange, which delivers nothing.
   */
  private async call(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    delivers: boolean,
  ): Promise<Response> {
    try {
      return await this.fetch(url, init);
    } catch (error) {
      if (signal.aborted && signal.reason instanceof PushDeliveryError) {
        throw signal.reason;
      }
      if (!delivers || neverConnected(error)) {
        throw new PushDeliveryError("unavailable", "FCM could not be reached", { cause: error });
      }
      throw new PushDeliveryError(
        "unknown",
        signal.aborted
          ? "The request to FCM was aborted, and FCM may have taken it"
          : "The connection to FCM failed, and FCM may have taken the request",
        { cause: error },
      );
    }
  }
}

/** The FCM message of one delivery: the text, the data the app opens, high priority. */
export function messageOf(request: PushSendRequest): Record<string, unknown> {
  return {
    token: request.token,
    notification: { body: request.body },
    // FCM data values are strings.
    data: {
      notificationId: request.data.notificationId,
      target: JSON.stringify(request.data.target),
    },
    android: { priority: "high", collapse_key: request.collapseKey },
    apns: {
      headers: { "apns-priority": "10", "apns-collapse-id": request.collapseKey },
      // Wakes the app in the background where iOS allows, so it can confirm
      // the push and refresh its copy of the orders.
      payload: { aps: { "content-available": 1 } },
    },
  };
}

/** The RS256 assertion Google exchanges for an access token (RFC 7523). */
export function signedAssertion(credentials: FcmCredentials, nowS: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: FCM_SCOPE,
      aud: credentials.tokenUrl,
      iat: nowS,
      exp: nowS + ASSERTION_LIFETIME_S,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(credentials.privateKey).toString("base64url")}`;
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/**
 * What an error answer of FCM means. The documented `errorCode` decides
 * where it can; then the status: 429 and 5xx pass, everything else is final.
 */
export function failureOf(
  status: number,
  error: z.infer<typeof errorAnswerSchema>["error"],
): PushDeliveryError {
  const code = error?.details?.find((detail) => detail.errorCode)?.errorCode ?? error?.status;
  const said = error?.message ? `: ${error.message}` : "";
  let kind: PushFailureKind =
    status === 429 || status === 408 || status >= 500 ? "unavailable" : "rejected";
  if (code && FAILURE_BY_ERROR_CODE[code]) {
    kind = FAILURE_BY_ERROR_CODE[code];
  } else if (
    code === "INVALID_ARGUMENT" &&
    /registration token|token/i.test(error?.message ?? "")
  ) {
    kind = "invalid_token";
  } else if (status === 401) {
    // A 404 is the token only when FCM says so (`UNREGISTERED`, above): a 404
    // of a wrong project path must not take every device off the list.
    // Our access token was refused; the provider took nothing. The next try
    // exchanges a fresh one.
    kind = "unavailable";
  }
  return new PushDeliveryError(
    kind,
    `FCM answered ${String(status)}${code ? ` ${code}` : ""}${said}`,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const NEVER_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function neverConnected(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && NEVER_CONNECTED.has(cause.code);
}
