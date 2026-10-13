import { isApiError } from "@adclub/api-client";
import {
  catalogRequestConflictDetailsSchema,
  type AdminCatalogRequest,
  type CatalogItemBrand,
  type CatalogItemType,
  type CatalogRequestStatus,
} from "@adclub/contracts";
import { actionErrorText } from "../errors";
import { formatMoment } from "../format";

/**
 * The words of «Запросы на позиции» (TASK-047; SCREENS A-MOD-01): the
 * status of a request, what the supplier's row said, the form of a new item
 * filled from it, and the refusals of the server.
 */

export const REQUEST_STATUS_TEXT: Record<CatalogRequestStatus, string> = {
  new: "Новый",
  approved: "Добавлено",
  rejected: "Отклонено",
};

const AVAILABILITY_TEXT = {
  in_stock: "в наличии",
  out_of_stock: "нет в наличии",
  on_order: "под заказ",
} as const;

/** «04465-0K090 · Geely · Колодки тормозные передние»: what identifies the row. */
export function requestTitle(data: AdminCatalogRequest["data"]): string {
  return [data.article, data.brand, data.name].filter(Boolean).join(" · ") || "Строка без данных";
}

/** «12 500 ₸ · под заказ · 3 р. дн.»: the terms the row offered (they may be stale by now). */
export function requestTermsText(data: AdminCatalogRequest["data"]): string {
  return [
    data.price === null ? null : `${data.price.toLocaleString("ru-RU")} ₸`,
    data.availability ? AVAILABILITY_TEXT[data.availability] : null,
    data.leadDays === null ? null : `срок ${String(data.leadDays)} р. дн.`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Where the request came from: «прайс price.xlsx, строка 214, 10.10.2026 14:05». */
export function requestSourceText(request: AdminCatalogRequest): string {
  // «Нет в справочнике? Отправьте запрос» of the cabinet (S-OFF-05, TASK-048).
  if (request.source === "manual") return "вручную, из кабинета поставщика";
  if (!request.import) return "—";
  const file = request.import.fileName ? `прайс ${request.import.fileName}` : "прайс";
  const row = request.import.rowNo === null ? null : `строка ${String(request.import.rowNo)}`;
  return [file, row, formatMoment(request.import.createdAt)].filter(Boolean).join(", ");
}

export interface RequestItemForm {
  type: CatalogItemType;
  brand: CatalogItemBrand | null;
  article: string;
  ru: string;
  /** The subcategory the supplier suggested by hand (S-OFF-05); the administrator may change it. */
  categoryId?: string;
}

/**
 * «Создать позицию»: the form of a new item filled from the row — a part
 * when the row has an article, a product described by its attributes when
 * it has none; the brand the server recognised by its spelling; the name as
 * the supplier wrote it. The subcategory is the administrator's to choose.
 */
export function itemFormFromRequest(request: AdminCatalogRequest): RequestItemForm {
  return {
    type: request.data.article ? "part" : "generic",
    brand: request.brand
      ? { id: request.brand.id, name: request.brand.name, isOem: false, status: "active" }
      : null,
    article: request.data.article ?? "",
    ru: request.data.name ?? "",
    ...(request.category && { categoryId: request.category.id }),
  };
}

/**
 * A refusal of the server on a request: decided meanwhile — who and when
 * («Запрос уже рассмотрел {кто}, {когда}»); anything else — the common words.
 */
export function requestErrorText(error: unknown): string {
  if (isApiError(error) && error.code === "CATALOG_REQUEST_VERSION_CONFLICT") {
    const details = catalogRequestConflictDetailsSchema.safeParse(error.details);
    if (details.success && details.data.status !== "new") {
      const who = details.data.decidedBy?.name ?? "другой администратор";
      const when = details.data.decidedAt ? `, ${formatMoment(details.data.decidedAt)}` : "";
      return `Запрос уже рассмотрел ${who}${when}: ${REQUEST_STATUS_TEXT[details.data.status].toLowerCase()}. Обновите страницу`;
    }
    return "Запрос только что изменили. Обновите страницу";
  }
  if (isApiError(error) && error.code === "VALIDATION_ERROR" && error.details) {
    const first = (error.details as { path?: string }[])[0];
    if (first?.path === "itemId") {
      return "Выберите активную запчасть или товар: услуги из прайса не выставляются";
    }
  }
  return actionErrorText(error);
}
