import type { LoginCodeChannel } from "@adclub/contracts";

export interface LoginCodeMessage {
  /** E.164, e.g. `+77011234567`. */
  phone: string;
  code: string;
  expiresAt: Date;
}

/**
 * The channel could not deliver the code (number not on WhatsApp,
 * rejected by the provider, provider down…). `reason` is a short
 * machine-readable token that is safe to log: it must never contain the
 * phone number or the code.
 */
export class LoginCodeDeliveryError extends Error {
  constructor(readonly reason: string) {
    super(`Login code delivery failed: ${reason}`);
    this.name = "LoginCodeDeliveryError";
  }
}

export interface LoginCodeSender {
  /** Resolves once the provider accepted the message; rejects otherwise. */
  send(message: LoginCodeMessage): Promise<void>;
}

/**
 * Delivery of login codes (ARCHITECTURE 8.1, 9.1, 9.2), one sender per
 * channel. **Replacement point**: TASK-026 provides the WhatsApp
 * authentication template and the SMS aggregator behind this same
 * interface (chosen by `LOGIN_CODE_CHANNELS` in `IdentityModule`); the
 * login code logic (fallback, limits, storage) doesn't change.
 */
export abstract class LoginCodeChannels {
  abstract sender(channel: LoginCodeChannel): LoginCodeSender;
}
