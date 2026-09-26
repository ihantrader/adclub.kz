import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { MessageTestMode } from "../../config";
import {
  MessageChannel,
  MessageDeliveryError,
  type MessageSendRequest,
  type MessageSendResult,
} from "./message-channel";

/**
 * The stand-in for the message provider (development, tests and CI):
 * sends nothing anywhere, answers deterministically and can be made to
 * fail every way the real channel can (`MESSAGE_TEST_MODE` sets the start
 * mode; tests change `mode` and `delayMs`). Refused in production, where
 * nobody would get a message (`loadConfig`).
 *
 * What it "sent" stays in `sent` for tests, and on the message rows for
 * `GET /dev/messages`, whichever process sent it.
 */
@Injectable()
export class TestMessageChannel extends MessageChannel {
  readonly provider = "test" as const;
  /** What the next sends do. */
  mode: MessageTestMode = "ok";
  /** How long a `slow` send takes, milliseconds. */
  delayMs = 5_000;
  /** Every accepted message, newest last (tests read it). */
  readonly sent: MessageSendRequest[] = [];

  async send(request: MessageSendRequest, signal: AbortSignal): Promise<MessageSendResult> {
    switch (this.mode) {
      case "unavailable":
        throw new MessageDeliveryError("unavailable", "The test message channel is unavailable");
      case "rate_limited":
        throw new MessageDeliveryError("rate_limited", "The test message channel limits us", {
          retryAfterSeconds: 30,
        });
      case "rejected":
        throw new MessageDeliveryError("rejected", "The test message channel refuses the request");
      case "template_not_approved":
        throw new MessageDeliveryError(
          "template_not_approved",
          `The template ${request.template} is not approved in ${request.lang}`,
        );
      case "no_whatsapp":
        throw new MessageDeliveryError("no_whatsapp", "The number is not on WhatsApp");
      case "outcome_unknown":
        throw new MessageDeliveryError(
          "outcome_unknown",
          "The test message channel timed out after the request was sent",
        );
      case "slow":
        await this.wait(this.delayMs, signal);
        break;
      default:
        break;
    }
    this.sent.push(request);
    // The shape of a real id, so nothing downstream depends on it being short;
    // random, because two worker processes each have their own counter and the
    // provider's id is unique in the table.
    return { providerMessageId: `wamid.TEST${randomUUID().replaceAll("-", "").toUpperCase()}` };
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
