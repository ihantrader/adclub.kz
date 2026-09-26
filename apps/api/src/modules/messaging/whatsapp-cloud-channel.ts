import { z } from "zod";
import {
  MessageChannel,
  MessageDeliveryError,
  type MessageFailureKind,
  type MessageSendRequest,
  type MessageSendResult,
} from "./message-channel";

/**
 * Meta's WhatsApp Cloud API behind `MessageChannel` (ARCHITECTURE 9.1
 * variant A, 4.35): `POST /{phoneNumberId}/messages` with a template
 * message, so plain `fetch` is enough and the project carries no provider
 * SDK — the same choice as the AI gateway (4.20 I185).
 *
 * **Nothing here has ever been called.** The project has no verified
 * business and no WhatsApp number yet (PROJECT_STATE 4), so every
 * deployment runs the test channel; this file is written from Meta's
 * documentation and exercised against a substituted `fetch` in tests. What
 * it cannot know until a real call is made — the exact wording of some
 * errors — is why failures are classified by the error **code** the Cloud
 * API documents rather than by its message.
 */

/** What the Cloud API answers when it took the message. */
const answerSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).optional(),
  error: z
    .object({
      message: z.string().optional(),
      type: z.string().optional(),
      code: z.number().optional(),
      error_subcode: z.number().optional(),
      error_data: z.object({ details: z.string().optional() }).optional(),
    })
    .optional(),
});

/**
 * The error codes of the Cloud API that decide what happens to a message
 * (Meta's "Cloud API error codes"). Anything not listed is decided by the
 * HTTP status, which is the safer reading: a status we don't recognise is
 * treated as temporary only when it is 429 or 5xx.
 */
const FAILURE_BY_CODE: Readonly<Record<number, MessageFailureKind>> = {
  // 1 / 2: an unknown error of the platform, a service that is down — worth
  // another try.
  1: "unavailable",
  2: "unavailable",
  // Too many calls, or too many messages to this number in a window.
  4: "rate_limited",
  80007: "rate_limited",
  130429: "rate_limited",
  131048: "rate_limited",
  131056: "rate_limited",
  // The access token or the permissions — 0 is "unable to authenticate the
  // app user", the same trouble as an expired token (190): a person has to fix
  // it, and retrying an expired token five times fixes nothing.
  0: "rejected",
  3: "rejected",
  10: "rejected",
  190: "rejected",
  200: "rejected",
  // The request itself.
  100: "rejected",
  // The template is missing (132001), paused (132015) or disabled (132016), or
  // not in this language: a person submits it or brings the registry in line.
  132001: "template_not_approved",
  132015: "template_not_approved",
  132016: "template_not_approved",
  // The template exists but our parameters do not fit it — their number
  // (132000), their format (132012), a text too long (132005) or against the
  // provider's policy (132007). The registry and the approved template
  // disagree; a person aligns them. Not an approval problem.
  132000: "rejected",
  132005: "rejected",
  132007: "rejected",
  132012: "rejected",
  // 131026, "message undeliverable": the number is not on WhatsApp, or the
  // person has not accepted the new terms, or runs a version that cannot
  // receive it. There is no other channel for a notification (PRODUCT 15).
  131026: "no_whatsapp",
  // 131030 is not "no WhatsApp": the recipient is not in the allowed list of a
  // sandbox or unverified account. That is our configuration, and the
  // operator must not be sent after the recipient's phone.
  131030: "rejected",
  131051: "rejected",
  // Something went wrong on the way; the message may not have been sent.
  131000: "unavailable",
  131005: "rejected",
  131008: "rejected",
  131009: "rejected",
  131016: "unavailable",
  131021: "rejected",
  131031: "rejected",
  131047: "rejected",
  131053: "rejected",
};

/** The failure kind a documented error code stands for; `undefined` — not one we know. */
export function failureKindOfCode(code: number | undefined): MessageFailureKind | undefined {
  return code === undefined ? undefined : FAILURE_BY_CODE[code];
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class WhatsappCloudChannel extends MessageChannel {
  readonly provider = "whatsapp_cloud" as const;

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    /** `https://graph.facebook.com/v21.0` (the version is part of it). */
    private readonly baseUrl: string,
    private readonly fetch: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    super();
  }

  async send(request: MessageSendRequest, signal: AbortSignal): Promise<MessageSendResult> {
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      // The Cloud API wants the number without the leading `+`.
      to: request.phone.replace(/^\+/, ""),
      type: "template",
      template: {
        name: request.providerTemplateName,
        language: { code: request.lang },
        components: componentsOf(request),
      },
    };
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/${this.phoneNumberId}/messages`, {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted && signal.reason instanceof MessageDeliveryError) {
        // The caller's own time limit: it knows why.
        throw signal.reason;
      }
      if (neverConnected(error)) {
        // The request provably did not leave: nothing can have been sent.
        throw new MessageDeliveryError("unavailable", "The Cloud API could not be reached", {
          cause: error,
        });
      }
      // Anything else — a timeout or an abort (the job's own limit), a
      // connection that dropped, a failure in the middle of the answer — may
      // have happened after the provider took the request. The Cloud API has
      // no idempotency key for a send, so trying again could deliver twice:
      // the outcome is unknown, and a person decides.
      throw new MessageDeliveryError(
        "outcome_unknown",
        signal.aborted
          ? "The request to the Cloud API was aborted, and the provider may have taken it"
          : "The connection to the Cloud API failed, and the provider may have taken the request",
        { cause: error },
      );
    }
    const text = await response.text();
    const parsed = safeJson(text);
    const answer = answerSchema.safeParse(parsed);
    if (!response.ok) {
      throw failureOf(
        response.status,
        answer.success ? answer.data.error : undefined,
        retryAfterOf(response),
      );
    }
    if (!answer.success) {
      // A 200 the provider meant as an acceptance, in a shape we cannot read:
      // it probably took the message, so it is not tried again by itself.
      throw new MessageDeliveryError(
        "outcome_unknown",
        "The Cloud API answered 200 in an unknown shape",
      );
    }
    if (answer.data.error) {
      throw failureOf(response.status, answer.data.error, retryAfterOf(response));
    }
    const id = answer.data.messages?.[0]?.id;
    if (!id) {
      // A 200 without an id: nothing to follow the delivery by, and we cannot
      // tell whether the message was sent. Not tried again by itself — a
      // second attempt could deliver a second copy — but left for a person.
      throw new MessageDeliveryError(
        "outcome_unknown",
        "The Cloud API answered 200 without a message id",
      );
    }
    return { providerMessageId: id };
  }
}

/**
 * The template's parameters, in the order the approved template has them,
 * plus one payload per quick reply. Named parameters are not used: the
 * approved template decides the order, and a mismatch there is a rejection
 * of the whole message.
 */
function componentsOf(request: MessageSendRequest): unknown[] {
  const components: unknown[] = [];
  if (request.variables.length > 0) {
    components.push({
      type: "body",
      parameters: request.variables.map((value) => ({ type: "text", text: value })),
    });
  }
  request.buttons.forEach((button, index) => {
    if (button.button.kind === "quick_reply" && button.payload !== undefined) {
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: String(index),
        parameters: [{ type: "payload", payload: button.payload }],
      });
    }
  });
  return components;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The errors of a connection that was never made: nothing left this
 * process, so nothing can have been delivered. Undici reports them as
 * `TypeError: fetch failed` with the system error as its `cause`.
 */
const NEVER_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  // Undici's own timeout of making the connection: the request had not been sent.
  "UND_ERR_CONNECT_TIMEOUT",
]);

function neverConnected(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && NEVER_CONNECTED.has(cause.code);
}

/** `Retry-After`, seconds, when the provider said how long to wait. */
function retryAfterOf(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

/**
 * What an answer of the Cloud API means for the message. The documented
 * error code decides where it can; otherwise the status does — 429 and 5xx
 * pass, everything else is final, because a request the provider refuses
 * for its own reasons is not fixed by sending it again.
 *
 * A 5xx is read as "not taken": the provider answered that it failed. That is
 * the one place a message could in principle be delivered and still be
 * retried — the Cloud API documents 5xx as a failure and offers no way to
 * ask, so the risk of a duplicate is accepted here and named in
 * ARCHITECTURE 4.35 rather than turning every provider hiccup into a message
 * a person has to look at.
 */
export function failureOf(
  status: number,
  error: { message?: string; code?: number; error_data?: { details?: string } } | undefined,
  retryAfterSeconds?: number,
): MessageDeliveryError {
  // The provider's own words name the template, the number's country or the
  // policy — never our text. `Messaging` sanitizes them before they are
  // written anywhere.
  const details = error?.error_data?.details;
  const said = [error?.message, details].filter(Boolean).join(" — ");
  const suffix = said ? `: ${said}` : "";
  const byStatus: MessageFailureKind =
    status === 429 ? "rate_limited" : status === 408 || status >= 500 ? "unavailable" : "rejected";
  const kind = failureKindOfCode(error?.code) ?? byStatus;
  // "error 132001", not "code=132001": the log sanitizer redacts anything that
  // reads as a login code, and the provider's error code is the one thing an
  // operator needs from this line.
  const code = error?.code === undefined ? "" : `, error ${String(error.code)}`;
  // What the provider asked for is in the line the operator reads, though the
  // pause between attempts is the queue's own (a setting): the queue does not
  // take a wait from a handler.
  const wait =
    retryAfterSeconds === undefined
      ? ""
      : `, the provider asks to wait ${String(retryAfterSeconds)} s`;
  return new MessageDeliveryError(
    kind,
    `The Cloud API answered ${String(status)}${code}${suffix}${wait}`,
    { retryAfterSeconds },
  );
}
