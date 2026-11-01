import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiException } from "../../common/errors";
import { CardBindings } from "./card-bindings";
import { PaymentProvider } from "./payment-provider";
import { TEST_CARDS, testBoundCard, type TestCardCode } from "./test-payment-provider";

/** Not part of the contract; excluded from the served-routes check (as `/dev/messages`). */
export const DEV_PAYMENT_CARD_PATH = "/dev/payment/card";
export const DEV_PAYMENT_CHOOSE_PATH = "/dev/payment/card/choose";
export const DEV_PAYMENT_CARD_PATHS = [DEV_PAYMENT_CARD_PATH, DEV_PAYMENT_CHOOSE_PATH] as const;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 560px; margin: 32px auto; padding: 0 16px; color: #1c1c1e; }
  h1 { font-size: 22px; }
  p.note { color: #6b6b70; font-size: 14px; }
  a.card, a.cancel { display: block; padding: 14px 16px; margin: 8px 0; border: 1px solid #c8c8cc; border-radius: 12px; text-decoration: none; color: inherit; }
  a.card:hover, a.cancel:hover { border-color: #0a7a5a; }
  a.card b { display: block; }
  a.cancel { color: #6b6b70; }
`;

/**
 * Development and tests only — and only while the payment provider is the
 * test one: the stand-in for the provider's own page where a person types a
 * card (TASK-042; ARCHITECTURE 4.77). It lists the test cards and what a
 * charge to each does; choosing one hands the card to the binding exactly as
 * the real provider's webhook would, and sends the browser back to the
 * cabinet. A real number is never asked for here and never typed — the real
 * page belongs to the provider, and this one has no field at all.
 */
@Controller()
export class DevPaymentCardController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(CardBindings) private readonly bindings: CardBindings,
    @Inject(PaymentProvider) private readonly provider: PaymentProvider,
  ) {}

  @Get(DEV_PAYMENT_CARD_PATH)
  async page(
    @Query("ref") ref: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const binding = ref ? await this.bindings.byRef("test", ref) : null;
    if (!binding || binding.status !== "pending") {
      throw new ApiException(404, "NOT_FOUND", "No open card page for this reference");
    }
    response.type("text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    const cards = TEST_CARDS.map(
      (card) =>
        `<a class="card" data-card="${card.code}" href="${DEV_PAYMENT_CHOOSE_PATH}?ref=${encodeURIComponent(binding.providerRef)}&amp;card=${card.code}"><b>${escapeHtml(card.label)}</b>${escapeHtml(card.number)} · ${card.brand}</a>`,
    ).join("");
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Платёжная система (тест)</title><style>${STYLE}</style></head><body><h1>Привязка карты</h1><p class="note">Тестовая страница платёжной системы: ничего не списывается, номер карты не вводится. Выберите карту — результат будет таким, как описано.</p>${cards}<a class="cancel" data-card="cancel" href="${DEV_PAYMENT_CHOOSE_PATH}?ref=${encodeURIComponent(binding.providerRef)}&amp;card=cancel">Закрыть без привязки</a></body></html>`;
  }

  @Get(DEV_PAYMENT_CHOOSE_PATH)
  async choose(
    @Query("ref") ref: string | undefined,
    @Query("card") card: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const binding = ref ? await this.bindings.byRef("test", ref) : null;
    if (!binding || binding.status !== "pending") {
      // A trip that is over takes no card: none is handed out to be left behind (I840).
      throw new ApiException(404, "NOT_FOUND", "No open card page for this reference");
    }
    if (card === "cancel") {
      await this.bindings.cancelled("test", binding.providerRef);
    } else {
      const known = TEST_CARDS.find((candidate) => candidate.code === card);
      if (!known) {
        throw new ApiException(400, "VALIDATION_ERROR", "Unknown test card", {
          details: [{ path: "card", message: "Unknown test card" }],
        });
      }
      const bound = testBoundCard(known.code as TestCardCode);
      const result = await this.bindings.cardReported("test", binding.providerRef, bound);
      // Two clicks at once: the trip took the first card, the second is forgotten.
      if (result === "foreign_card") await this.provider.detachCard(bound.token);
    }
    // The browser goes back to the cabinet, as the real provider's page sends it.
    response.setHeader("cache-control", "no-store");
    response.redirect(303, binding.returnUrl);
  }
}
