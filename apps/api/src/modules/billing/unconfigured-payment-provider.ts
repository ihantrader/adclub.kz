import {
  PaymentProvider,
  PaymentProviderUnavailableError,
  PaymentWebhookError,
  type BindingLookup,
  type BindingStart,
  type ChargeResult,
  type ParsedPaymentWebhook,
  type PaymentLookup,
} from "./payment-provider";

/**
 * The card processor of Kazakhstan before its class exists (TASK-042):
 * `PAYMENT_PROVIDER=card_kz` starts — the application must, production
 * refuses the test provider — and every call answers «unavailable». Nothing
 * is charged and nobody is paused for it (an unavailable provider is not
 * the payer's fault), the administrator sees the signal «Платёжная система
 * недоступна», and the cabinet says it can't reach the payment system. When
 * the contract with Freedom Pay or CloudPayments KZ is signed, the real class
 * replaces this one behind the same port.
 */
export class UnconfiguredPaymentProvider extends PaymentProvider {
  readonly name = "card_kz" as const;

  beginCardBinding(): Promise<BindingStart> {
    return Promise.reject(
      new PaymentProviderUnavailableError("The card processor is not connected"),
    );
  }

  getCardBinding(): Promise<BindingLookup> {
    return Promise.reject(
      new PaymentProviderUnavailableError("The card processor is not connected"),
    );
  }

  charge(): Promise<ChargeResult> {
    return Promise.resolve({ kind: "unavailable", detail: "The card processor is not connected" });
  }

  getPayment(): Promise<PaymentLookup> {
    return Promise.resolve({ kind: "unavailable", detail: "The card processor is not connected" });
  }

  detachCard(): Promise<void> {
    return Promise.reject(
      new PaymentProviderUnavailableError("The card processor is not connected"),
    );
  }

  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): ParsedPaymentWebhook {
    throw new PaymentWebhookError("The card processor is not connected");
  }
}
