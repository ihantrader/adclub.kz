import { isApiError } from "@adclub/api-client";
import {
  priceMatchAuditConflictDetailsSchema,
  type AdminPriceMatchAudit,
  type PriceMatchAuditBucketId,
  type PriceMatchAuditCard,
  type PriceMatchAuditKeepReason,
  type PriceMatchAuditResult,
  type PriceMatchAuditStatus,
} from "@adclub/contracts";
import { actionErrorText } from "../errors";
import { formatMoment } from "../format";

/**
 * The words of «Аудит сопоставлений» (TASK-065; SCREENS A-MOD-04): states,
 * confidence buckets, what «Неверно» will do and did, the refusals.
 */

export const AUDIT_STATUS_TEXT: Record<PriceMatchAuditStatus, string> = {
  pending: "Ждёт проверки",
  correct: "Верно",
  wrong: "Неверно",
};

export const BUCKET_TEXT: Record<PriceMatchAuditBucketId, string> = {
  lt_0_7: "0,5–0,7",
  "0_7_0_85": "0,7–0,85",
  "0_85_0_95": "0,85–0,95",
  gte_0_95: "≥ 0,95",
};

/** 0.93 → «0,93». */
export function confidenceText(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

/** 0.917 → «91,7 %», `null` — «—». */
export function percentText(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1).replace(".", ",")} %`;
}

export function reasonText(reason: AdminPriceMatchAudit["reason"]): string {
  return reason === "below" ? "Уверенность ниже порога «всегда проверять»" : "Случайная выборка";
}

/** «04465-0K090 · Geely · Колодки…»: what the supplier's row said. */
export function auditRowTitle(row: AdminPriceMatchAudit["row"]): string {
  return [row.article, row.brand, row.name].filter(Boolean).join(" · ") || "Строка без названия";
}

const KEEP_TEXT: Record<
  Exclude<PriceMatchAuditKeepReason, "active_orders" | "no_offer">,
  string
> = {
  not_active: "уже не в продаже",
  edited: "его правили вручную после загрузки — останется",
};

/** What «Неверно…» will do, said before the administrator confirms it (A-MOD-04). */
export function wrongConsequences(card: PriceMatchAuditCard): string[] {
  const lines = [
    "Память поставщика для этой строки будет удалена: следующая загрузка прайса снова пойдёт в «Нужно проверить».",
  ];
  const offer = card.offer;
  const name = card.audit.aiItem?.name.text ?? "позиция";
  if (offer) {
    if (offer.willWithdraw) {
      lines.push(`Предложение «${name}» будет снято с продажи.`);
    } else if (offer.keepReason === "active_orders") {
      lines.push(
        `Активные заявки: ${String(offer.activeOrders)} — предложение «${name}» останется.`,
      );
    } else if (offer.keepReason && offer.keepReason !== "no_offer") {
      lines.push(`Предложение «${name}» ${KEEP_TEXT[offer.keepReason]}.`);
    }
  }
  lines.push(
    "Поставщик увидит исправление в «Модерации». Предложение на правильной позиции не создаётся: поставщик выставит его сам.",
  );
  return lines;
}

/** What «Неверно» did (the result of the server). */
export function wrongResultText(result: PriceMatchAuditResult): string {
  const parts = [result.memoryRemoved ? "Память поставщика удалена" : "Памяти для строки не было"];
  if (result.offerWithdrawn) parts.push("предложение снято с продажи");
  else if (result.keepReason === "active_orders")
    parts.push(`предложение осталось: активные заявки — ${String(result.activeOrders)}`);
  else if (result.keepReason === "edited") parts.push("предложение осталось: его правили вручную");
  else if (result.keepReason === "not_active") parts.push("предложение уже было не в продаже");
  return `${parts.join(", ")}.`;
}

export function auditErrorText(error: unknown): string {
  if (isApiError(error) && error.code === "PRICE_MATCH_AUDIT_CONFLICT") {
    const details = priceMatchAuditConflictDetailsSchema.safeParse(error.details);
    if (details.success && details.data.status !== "pending") {
      const who = details.data.decidedBy?.name ?? "другой администратор";
      const when = details.data.decidedAt ? `, ${formatMoment(details.data.decidedAt)}` : "";
      return `Строку уже проверил ${who}${when}: «${AUDIT_STATUS_TEXT[details.data.status]}». Обновите страницу`;
    }
    return "Строку только что изменили. Обновите страницу";
  }
  if (isApiError(error) && error.code === "VALIDATION_ERROR" && error.details) {
    const first = (error.details as { path?: string }[])[0];
    if (first?.path === "correctItemId") {
      return "Выберите активную запчасть или товар — другую, чем предложил ИИ, — или «Такой позиции нет в справочнике»";
    }
  }
  return actionErrorText(error);
}
