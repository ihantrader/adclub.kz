import type {
  AdminModerationEntry,
  AdminModerationKind,
  AdminModerationSource,
} from "@adclub/contracts";
import { catalogItemPath, catalogRequestPath } from "../router";

/** The words of «Модерация» (TASK-071, TASK-068; texts are ours, waiting for SCREENS). */
export const KIND_TEXT: Record<AdminModerationKind, string> = {
  item_request: "Позиция",
  compatibility: "Совместимость",
  photo: "Фото",
};

export const SOURCE_TEXT: Record<AdminModerationSource, string> = {
  price_import: "Прайс",
  manual: "Вручную",
  cabinet: "Кабинет",
  search: "Поиск фото",
};

const KINDS = Object.keys(KIND_TEXT) as AdminModerationKind[];

/** The filters of the queue in the address, under the server's names. */
export interface ModerationFilters {
  kind?: AdminModerationKind;
  supplierId?: string;
}

export function moderationFiltersOf(query: URLSearchParams): ModerationFilters {
  const kind = query.get("kind");
  const supplierId = query.get("supplierId")?.trim();
  return {
    kind: KINDS.find((known) => known === kind),
    supplierId: supplierId || undefined,
  };
}

/** The card a row opens: the request itself, the item's «Совместимость» or «Фото». */
export function entryHref(entry: AdminModerationEntry): string {
  switch (entry.kind) {
    case "item_request":
      return catalogRequestPath(entry.id);
    case "compatibility":
      return catalogItemPath(entry.item?.id ?? entry.id, "compatibility");
    case "photo":
      return catalogItemPath(entry.item?.id ?? entry.photo?.itemId ?? entry.id, "photos");
  }
}

/** The first line: what is asked — the name sent, or the item of the proposal or the photo. */
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

/** Who put a photo forward (A-MOD-03): [AI] — the search; a supplier — by its name. */
export function photoOrigin(entry: AdminModerationEntry): "ai" | string | null {
  if (entry.kind !== "photo" || !entry.photo) return null;
  if (entry.photo.proposedBy === "ai") return "ai";
  return entry.supplier ? `от поставщика ${entry.supplier.name}` : "от поставщика";
}

/** The host of a source page, for its short link («geely.com»). */
export function sourceHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
