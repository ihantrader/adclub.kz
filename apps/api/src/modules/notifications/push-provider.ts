import type { PushPlatform, PushTargetValue } from "@adclub/contracts";

/**
 * Who took one delivery (`notification_delivery.provider`): the test
 * stand-in, FCM (Android) or APNs (iOS, TASK-056). With
 * `PUSH_PROVIDER=live` the platform of the device decides between the two
 * real ones (`PlatformPushRouter`).
 */
export type PushChannelName = "test" | "fcm" | "apns";

/**
 * The one way a push leaves the platform (PRODUCT 15; ARCHITECTURE 9.3,
 * 4.79): the port talks to the provider and nothing else; the service
 * around it (`Notifications`, `PushSender`) owns the queue, the journal and
 * the checks, and modules never reach for a provider themselves.
 */

/** What one send needs: one notification to one device. Nothing here is written to a log. */
export interface PushSendRequest {
  /** The device's token — whole only here, on its way to the provider. */
  token: string;
  platform: PushPlatform;
  /** The text as SCREENS 8.4 has it, in the person's language; no title (the app's name is). */
  body: string;
  /** What a tap opens, and the id the app confirms the push by. */
  data: { notificationId: string; target: PushTargetValue };
  /**
   * One key per notification: a provider that collapses by it shows one
   * banner however many devices or retries (FCM `collapse_key`, APNs
   * `apns-collapse-id`).
   */
  collapseKey: string;
}

export interface PushSendResult {
  /** The provider's id of the message (`projects/…/messages/…`). */
  providerMessageId: string;
}

/**
 * Why a send failed, which decides what happens to the delivery:
 *
 * - `invalid_token` — the token is dead (FCM `UNREGISTERED`, or
 *   `INVALID_ARGUMENT` about the token): the device is taken off push, the
 *   person's other devices still get it;
 * - `unavailable` — the provider can't be reached, is overloaded, limited us
 *   or answered 5xx: try again later;
 * - `rejected` — the request is refused for good (the project's credentials,
 *   a malformed message): not tried again;
 * - `unknown` — the request may have reached the provider and nobody can tell
 *   (a timeout after the connection was made, a dropped connection, a 200
 *   without an id). **Never retried by itself**: a person decides
 *   (`push:retry`), the same rule as messages to suppliers.
 */
export type PushFailureKind = "invalid_token" | "unavailable" | "rejected" | "unknown";

/** A failed send. `message` is safe for a log: never the token, the text or the data. */
export class PushDeliveryError extends Error {
  constructor(
    readonly kind: PushFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PushDeliveryError";
  }
}

/** The provider behind the port. `signal` is aborted when the send takes longer than the job allows. */
export abstract class PushProvider {
  /** Who takes a push to a device of this platform — written on the delivery. */
  abstract providerFor(platform: PushPlatform): PushChannelName;

  abstract send(request: PushSendRequest, signal: AbortSignal): Promise<PushSendResult>;
}

/**
 * The token as anything but the provider may show it: the platform's tokens
 * are long, so the first six and the last four characters say which device
 * it is and nothing more.
 */
export function maskToken(token: string): string {
  if (token.length <= 12) {
    return "…";
  }
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
