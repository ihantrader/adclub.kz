import { isApiError } from "@adclub/api-client";
import type {
  CatalogRequestStatus,
  CompatibilityConditionsLabel,
  CompatibilityProposalStatus,
  CreateCatalogRequestBody,
  SupplierCatalogRequest,
} from "@adclub/contracts";
import type { SupplierTextKey } from "@adclub/i18n";
import type { StatusTone } from "../price/price-rules";
import { retryMinutes } from "../errors";
import type { Translate } from "../i18n";

/**
 * What «Модерация» (S-MOD-01) and the request for an item (S-OFF-05)
 * decide on the screen (TASK-048): the words of a status, what a request
 * said, the action an added item offers, the form's body and refusals.
 * Whether a decision is «новое» is the server's (`isNew`).
 */

export type ModerationStatus = CatalogRequestStatus | CompatibilityProposalStatus;

/** «На рассмотрении» / «Добавлено» / «Отклонено: {причина}». */
export function statusText(status: ModerationStatus, reason: string | null, t: Translate): string {
  switch (status) {
    case "new":
    case "pending":
      return t("moderation.status.waiting");
    case "approved":
      return t("moderation.status.added");
    case "rejected":
      return reason
        ? t("moderation.status.rejected", { reason })
        : t("moderation.status.rejectedPlain");
  }
}

export function statusTone(status: ModerationStatus): StatusTone {
  return status === "approved" ? "success" : status === "rejected" ? "danger" : "warning";
}

/** The cars of a compatibility proposal: «Geely Atlas II · JLH-4G20TDB · 2023–…». */
export function conditionsText(label: CompatibilityConditionsLabel): string {
  return [
    [label.make, label.model, label.generation].filter(Boolean).join(" "),
    label.body,
    label.engine,
    label.transmission,
    label.drive,
    label.years,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a request said: the name, then brand and article. */
export function requestTitle(request: SupplierCatalogRequest): { name: string; line: string } {
  const data = request.data;
  return {
    name: data.name ?? data.article ?? "",
    line: [data.brand, data.article].filter(Boolean).join(" · "),
  };
}

/** Where a request came from: «Из прайса · строка N» or «Вручную». */
export function requestSource(request: SupplierCatalogRequest, t: Translate): string {
  return request.source === "manual"
    ? t("moderation.manual")
    : request.rowNo !== null
      ? t("moderation.fromPrice", { row: String(request.rowNo) })
      : t("moderation.fromPricePlain");
}

/**
 * The action of an added item: open the company's offer on it, or «Выставить»
 * — the form of a new offer; nothing until the request is added.
 */
export function addedAction(request: SupplierCatalogRequest): "open" | "put" | null {
  if (request.status !== "approved" || !request.item) return null;
  return request.offer ? "open" : "put";
}

/** The form of S-OFF-05 as typed. */
export interface RequestForm {
  name: string;
  brand: string;
  article: string;
  categoryId: string | null;
  comment: string;
}

export const EMPTY_REQUEST: RequestForm = {
  name: "",
  brand: "",
  article: "",
  categoryId: null,
  comment: "",
};

/** The form as the server takes it; `null` — the name is still missing. */
export function requestBody(form: RequestForm): CreateCatalogRequestBody | null {
  const name = form.name.trim();
  if (name.length < 2) return null;
  const optional = (value: string) => {
    const text = value.trim();
    return text === "" ? undefined : text;
  };
  const brand = optional(form.brand);
  const article = optional(form.article);
  const comment = optional(form.comment);
  return {
    name,
    ...(brand && { brand }),
    ...(article && { article }),
    ...(form.categoryId && { categoryId: form.categoryId }),
    ...(comment && { comment }),
  };
}

/**
 * What the search typed becomes in the form: an article-like query (digits,
 * no spaces) — the article; anything else — the name.
 */
export function formFromQuery(query: string): RequestForm {
  const text = query.trim();
  if (text !== "" && /\d/.test(text) && !/\s/.test(text))
    return { ...EMPTY_REQUEST, article: text };
  return { ...EMPTY_REQUEST, name: text };
}

/** A refused request, in words; `existing` — the id of the request already waiting. */
export function requestRefusal(
  error: unknown,
  t: Translate,
): { text: string; existing: string | null } {
  if (!isApiError(error)) return { text: t("common.saveFailed"), existing: null };
  switch (error.code) {
    case "CATALOG_REQUEST_EXISTS": {
      const details = error.details as { requestId?: unknown } | undefined;
      return {
        text: t("request.exists"),
        existing: typeof details?.requestId === "string" ? details.requestId : null,
      };
    }
    case "RATE_LIMITED":
      return { text: t("request.tooMany", { minutes: retryMinutes(error) }), existing: null };
    case "VALIDATION_ERROR":
      return { text: t("request.invalid"), existing: null };
    case "NETWORK_ERROR":
      return { text: t("common.saveOffline"), existing: null };
    default:
      return { text: t("common.saveFailed"), existing: null };
  }
}

export const MODERATION_TABS = ["requests", "compatibility"] as const;

export type ModerationTab = (typeof MODERATION_TABS)[number];

export const MODERATION_TAB_TEXT: Record<ModerationTab, SupplierTextKey> = {
  requests: "moderation.tabRequests",
  compatibility: "moderation.tabCompatibility",
};
