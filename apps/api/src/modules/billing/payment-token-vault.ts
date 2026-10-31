import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config";
import { openSecret, sealSecret } from "../identity";

/**
 * Seals the tokens of cards (ARCHITECTURE 4.77; TASK-042): the processor's
 * token is the one secret the subscription keeps, and the database alone
 * must not yield a usable one. AES-256-GCM — the construction the admin
 * second factor uses for its secrets (`sealSecret`) — with a key of its own,
 * derived from `PAYMENT_TOKEN_ENCRYPTION_KEY`; it is not the TOTP key, so
 * losing or rotating one never touches the other. The ciphertext is bound to
 * the row that holds it (`context`), so one copied to another row doesn't
 * open.
 *
 * What is not a secret — the mask, the brand, the term — is stored plain.
 */
@Injectable()
export class PaymentTokenVault {
  private readonly key: Buffer;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = createHash("sha256")
      .update("adclub:payment-token:")
      .update(config.payments.tokenEncryptionKey)
      .digest();
  }

  seal(context: string, token: string): string {
    return sealSecret(this.key, context, token);
  }

  open(context: string, sealed: string): string {
    return openSecret(this.key, context, sealed);
  }
}

/** Where a sealed token belongs: the row it is bound to. */
export const tokenContext = {
  paymentMethod: (id: string) => `payment_method:${id}`,
  cardBinding: (id: string) => `card_binding:${id}`,
  webhookEvent: (id: string) => `payment_webhook_event:${id}`,
};
