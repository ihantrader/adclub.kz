import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { PushTestMode } from "../../config";
import {
  PushDeliveryError,
  PushProvider,
  type PushSendRequest,
  type PushSendResult,
} from "./push-provider";

/**
 * The stand-in for the push provider (development, tests and CI): sends
 * nothing anywhere, answers deterministically and can be made to fail every
 * way the real one can (`PUSH_TEST_MODE` sets the start mode; tests change
 * `mode`, `delayMs` and `deadTokens`). Refused in production (`loadConfig`).
 *
 * What it "sent" stays in `sent` for tests, and on the delivery rows for
 * `GET /dev/pushes`, whichever process sent it.
 */
@Injectable()
export class TestPushProvider extends PushProvider {
  readonly provider = "test" as const;
  mode: PushTestMode = "ok";
  /** How long a `slow` send takes, milliseconds. */
  delayMs = 5_000;
  /** Every accepted push, newest last (tests read it). */
  readonly sent: PushSendRequest[] = [];
  /** Tokens the provider calls dead whatever the mode (one device of several, AC-3). */
  readonly deadTokens = new Set<string>();

  async send(request: PushSendRequest, signal: AbortSignal): Promise<PushSendResult> {
    if (this.deadTokens.has(request.token)) {
      throw new PushDeliveryError(
        "invalid_token",
        "The test push provider: the token is unregistered",
      );
    }
    switch (this.mode) {
      case "unavailable":
        throw new PushDeliveryError("unavailable", "The test push provider is unavailable");
      case "rejected":
        throw new PushDeliveryError("rejected", "The test push provider refuses the request");
      case "invalid_token":
        throw new PushDeliveryError(
          "invalid_token",
          "The test push provider: the token is unregistered",
        );
      case "unknown":
        throw new PushDeliveryError(
          "unknown",
          "The test push provider timed out after the request was sent",
        );
      case "slow":
        await wait(this.delayMs, signal);
        break;
      default:
        break;
    }
    this.sent.push(request);
    return { providerMessageId: `projects/adclub-test/messages/${randomUUID()}` };
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
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
