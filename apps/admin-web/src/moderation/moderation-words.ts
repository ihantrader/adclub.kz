import type {
  AdminModerationEntry,
  AdminModerationKind,
  AdminModerationSource,
} from "@adclub/contracts";
import { catalogItemPath, catalogRequestPath } from "../router";

/** The words of «Модерация» (TASK-071; texts are ours, waiting for SCREENS). */
export const KIND_TEXT: Record<AdminModerationKind, string> = {
  item_request: "Позиция",
  compatibility: "Совместимость",
};

export const SOURCE_TEXT: Record<AdminModerationSource, string> = {
  price_import: "Прайс",
  manual: "Вручную",
  cabinet: "Кабинет",
};

/** The filters of the queue in the address, under the server's names. */
export interface ModerationFilters {
  kind?: AdminModerationKind;
  supplierId?: string;
}

export function moderationFiltersOf(query: URLSearchParams): ModerationFilters {
  const kind = query.get("kind");
  const supplierId = query.get("supplierId")?.trim();
  return {
    kind: kind === "item_request" || kind === "compatibility" ? kind : undefined,
    supplierId: supplierId || undefined,
  };
}

/** The card a row opens: the request itself, or the item's «Совместимость». */
export function entryHref(entry: AdminModerationEntry): string {
  return entry.kind === "item_request"
    ? catalogRequestPath(entry.id)
    : catalogItemPath(entry.item?.id ?? entry.id, "compatibility");
}

/** The first line: what is asked — the name sent, or the item of the proposal. */
export function entryTitle(entry: AdminModerationEntry): string {
  if (entry.kind === "item_request") {
    return entry.proposed?.name ?? entry.proposed?.article ?? "Без названия";
  }
  return entry.item?.name ?? entry.item?.article ?? "Позиция справочника";
}

/** The muted line: the brand and the article; for a proposal — the cars too. */
export function entrySub(entry: AdminModerationEntry): string | null {
  const source = entry.kind === "item_request" ? entry.proposed : entry.item;
  const line = [source?.brand, source?.article].filter(Boolean).join(" · ");
  if (entry.kind === "compatibility") {
    return [line, entry.vehicle].filter(Boolean).join(" — ") || null;
  }
  return line || null;
}
