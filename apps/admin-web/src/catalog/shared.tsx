import type { CategoryIcon } from "@adclub/contracts";
import { glyphGrid } from "@adclub/ui-core";

import { apiClient } from "../api";
import { actorText } from "../audit/audit-words";
import { routePaths } from "../router";
import { categoryGlyphs } from "./category-glyphs";

const TABS = [
  { key: "tree", label: "Категории", href: routePaths.catalog },
  { key: "items", label: "Позиции", href: routePaths.catalogItems },
  { key: "proposals", label: "Предложения совместимости", href: routePaths.catalogProposals },
  { key: "requests", label: "Запросы на позиции", href: routePaths.catalogRequests },
] as const;

export type CatalogTab = (typeof TABS)[number]["key"];

/** The pages of «Справочник» (A-CAT-01…05) — the one bar of tabs of its `Header`. */
export function catalogTabs(active: CatalogTab) {
  return { label: "Справочник", items: TABS, active };
}

/** The way back from a page of an object of «Справочник» (X11: crumbs, not the section's tabs). */
export const CATALOG_CRUMB = { label: "Справочник", href: routePaths.catalog };
export const ITEMS_CRUMB = { label: "Позиции", href: routePaths.catalogItems };
export const REQUESTS_CRUMB = { label: "Запросы на позиции", href: routePaths.catalogRequests };

export { AppLink, follow } from "../layout/layout";

/** The glyph of a category code (the same map the app draws from, design/icons/icons.mjs). */
export function CategoryGlyph({ icon, size = 20 }: { icon: CategoryIcon | null; size?: number }) {
  if (!icon) return <span className="category-glyph category-glyph--none" aria-hidden="true" />;
  const glyph = categoryGlyphs[icon];
  return (
    <svg
      className="category-glyph"
      width={size}
      height={size}
      viewBox={glyphGrid.viewBox}
      aria-hidden="true"
      focusable="false"
    >
      {glyph.map((part, index) =>
        part.stroke ? (
          <path
            key={index}
            d={part.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={glyphGrid.lightStroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path key={index} d={part.d} fill="currentColor" />
        ),
      )}
    </svg>
  );
}

/**
 * Who changed a thing last, for «Эти данные только что изменил {кто}»
 * (SCREENS 7.0): the newest entry of the journal about it. `null` when the
 * journal can't say (it is only a courtesy — the conflict is the server's).
 */
export async function whoChanged(entityType: string, entityId: string): Promise<string | null> {
  try {
    const page = await apiClient.listAuditLog({ query: { entityType, entityId, limit: 1 } });
    const entry = page.entries[0];
    return entry ? actorText(entry.actor) : null;
  } catch {
    return null;
  }
}
