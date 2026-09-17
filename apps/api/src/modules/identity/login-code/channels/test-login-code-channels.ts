import type { LoginCodeChannel } from "@adclub/contracts";
import type { DevLoginCodeOutbox } from "./dev-login-code-outbox";
import {
  LoginCodeChannels,
  LoginCodeDeliveryError,
  type LoginCodeMessage,
  type LoginCodeSender,
} from "./login-code-channels";

/**
 * Stand-ins for WhatsApp and SMS (development and tests; refused in
 * production). Nothing leaves the process: a "sent" code goes to the dev
 * outbox if there is one. A channel listed in `failing` reports a delivery
 * failure instead — how the SMS fallback is exercised
 * (`LOGIN_CODE_TEST_FAILING_CHANNELS`, or `failing` directly in tests).
 */
export class TestLoginCodeChannels extends LoginCodeChannels {
  readonly failing: Set<LoginCodeChannel>;
  /** Every accepted message, newest last (tests read it). */
  readonly sent: Array<LoginCodeMessage & { channel: LoginCodeChannel }> = [];

  constructor(
    failing: Iterable<LoginCodeChannel>,
    private readonly outbox: DevLoginCodeOutbox | undefined,
  ) {
    super();
    this.failing = new Set(failing);
  }

  sender(channel: LoginCodeChannel): LoginCodeSender {
    return {
      send: (message) => {
        if (this.failing.has(channel)) {
          return Promise.reject(new LoginCodeDeliveryError("test_channel_configured_to_fail"));
        }
        this.sent.push({ ...message, channel });
        this.outbox?.record({
          sentAt: new Date().toISOString(),
          channel,
          phone: message.phone,
          code: message.code,
          expiresAt: message.expiresAt.toISOString(),
        });
        return Promise.resolve();
      },
    };
  }
}
