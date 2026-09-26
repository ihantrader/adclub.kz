import type { MessageProviderName } from "../../config";
import type { MessageTemplateButton, MessageTemplateKey } from "./message-templates";

/**
 * The one way a message leaves the platform for a supplier's employee
 * (PRODUCT 8.4, 15; ARCHITECTURE 9.1, 4.35) — the same shape as the port
 * to AI (4.19 I173): the port talks to the provider and nothing else, the
 * service around it (`Messaging`) owns the queue, the accounting and the
 * checks, and modules never reach for a channel themselves.
 *
 * A message is always an approved template in a language the recipient
 * reads: there is no "send this text" method, because a text nobody
 * approved would be refused by the provider anyway (SCREENS 8.5).
 */

/** What one send needs. Nothing here is written to a log. */
export interface MessageSendRequest {
  /** E.164, as the project stores numbers. */
  phone: string;
  template: MessageTemplateKey;
  /** The approved template's name at the provider. */
  providerTemplateName: string;
  /** The language of the recipient, as the provider names it (`kk`, `ru`). */
  lang: "kk" | "ru";
  /** The template's placeholders in the order the approved template has them. */
  variables: readonly string[];
  /** The buttons of the template, with the payload of each quick reply. */
  buttons: readonly MessageButtonToSend[];
  /**
   * The text as we render it ourselves. The real provider does not take a
   * text — the approved template holds it — but the test channel shows it,
   * the length check measures it, and development reads it.
   */
  text: string;
}

export interface MessageButtonToSend {
  button: MessageTemplateButton;
  /** A quick reply's payload; `undefined` for a link button. */
  payload?: string;
}

/** What the provider answered: the id it will report delivery under. */
export interface MessageSendResult {
  /** The provider's id of the message (`wamid.…`), the key delivery events arrive with. */
  providerMessageId: string;
}

/**
 * Why a send failed, which decides what happens to the message:
 *
 * - `unavailable` — the provider can't be reached, is overloaded or
 *   answered 5xx: try again later;
 * - `rate_limited` — the provider limits us (429): try again later, after
 *   `retryAfterSeconds` if it said so;
 * - `template_not_approved` — this template is not approved, or not in
 *   this language: no retry can help, a person submits it to the provider;
 * - `no_whatsapp` — the number is not on WhatsApp. Final: there is no
 *   fallback channel for notifications (PRODUCT 15 — SMS is not used for
 *   them), and the event stays in the cabinet;
 * - `rejected` — the provider refuses the request for good (a bad token,
 *   a forbidden number, a malformed request, a template whose parameters do
 *   not fit it);
 * - `outcome_unknown` — the request may have reached the provider and we
 *   cannot tell whether it took the message: it timed out or was aborted
 *   after the connection was made, the connection dropped, or the answer was
 *   a 200 with nothing to follow the message by. **Never retried by
 *   itself**: the Cloud API has no idempotency key for a send, so a second
 *   attempt could reach a real person twice — the message is `unknown` and a
 *   person decides (`messages:retry`);
 * - `not_configured` — no channel is set up for this.
 */
export type MessageFailureKind =
  | "unavailable"
  | "rate_limited"
  | "template_not_approved"
  | "no_whatsapp"
  | "rejected"
  | "outcome_unknown"
  | "not_configured";

/**
 * Failures worth trying again: the provider certainly did not take the
 * message. Everything else is final for this message — and `outcome_unknown`
 * is deliberately not here (see above).
 */
export const TEMPORARY_FAILURES: readonly MessageFailureKind[] = ["unavailable", "rate_limited"];

export function isTemporaryFailure(kind: MessageFailureKind): boolean {
  return TEMPORARY_FAILURES.includes(kind);
}

/**
 * A failed send. `message` is safe for a log: it never carries the number,
 * the text or the variables — only what the provider said about itself.
 */
export class MessageDeliveryError extends Error {
  constructor(
    readonly kind: MessageFailureKind,
    message: string,
    options?: ErrorOptions & { retryAfterSeconds?: number },
  ) {
    super(message, options);
    this.name = "MessageDeliveryError";
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }

  /** What the provider asked us to wait, seconds; `undefined` — it did not say. */
  readonly retryAfterSeconds: number | undefined;
}

/**
 * The provider behind the port. `signal` is aborted when the send takes
 * longer than the job allows.
 */
export abstract class MessageChannel {
  abstract readonly provider: MessageProviderName;

  abstract send(request: MessageSendRequest, signal: AbortSignal): Promise<MessageSendResult>;
}
