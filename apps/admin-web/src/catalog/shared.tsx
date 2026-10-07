import type { CatalogText, CatalogTexts, CategoryIcon } from "@adclub/contracts";
import { glyphGrid } from "@adclub/ui-core";
import type { MouseEvent, ReactNode } from "react";
import { apiClient } from "../api";
import { actorText } from "../audit/audit-words";
import { navigateTo, routePaths } from "../router";
import { categoryGlyphs } from "./category-glyphs";

const TABS = [
  { key: "tree", label: "Категории", href: routePaths.catalog },
  { key: "items", label: "Позиции", href: routePaths.catalogItems },
  { key: "proposals", label: "Предложения совместимости", href: routePaths.catalogProposals },
] as const;

/** The pages of «Справочник» (A-CAT-01…05): real links with their own addresses. */
export function CatalogTabs({ active }: { active: (typeof TABS)[number]["key"] | null }) {
  return (
    <nav className="page-tabs" aria-label="Справочник">
      {TABS.map((tab) => (
        <a
          key={tab.key}
          href={tab.href}
          className={tab.key === active ? "page-tabs__tab page-tabs__tab--on" : "page-tabs__tab"}
          aria-current={tab.key === active ? "page" : undefined}
          onClick={(event) => follow(event, tab.href)}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

/** A plain left click on a link goes through the admin panel's router; the rest is the browser's. */
export function follow(event: MouseEvent, href: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigateTo(href);
}

/** A link inside the admin panel. */
export function AppLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} onClick={(event) => follow(event, href)}>
      {children}
    </a>
  );
}

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

/** Where a text came from: the source, an AI translation or a hand-written one. */
export function originText(text: CatalogText | null): string {
  if (!text) return "нет";
  if (text.origin === "source") return "исходный";
  if (text.origin === "manual") return "вручную";
  return "ИИ";
}

/** One name in three languages, the Kazakh and English with where they came from. */
export function TextsLine({ texts }: { texts: CatalogTexts }) {
  const lang = (code: "kk" | "en", text: CatalogText | null) => (
    <span className="texts-line__lang" title={text?.text}>
      <span className="ac-muted">{code}:</span>{" "}
      {text ? (
        <>
          <span className="clamp">{text.text}</span>{" "}
          <span className="origin-tag">{originText(text)}</span>
        </>
      ) : (
        <span className="warning-text">нет перевода</span>
      )}
    </span>
  );
  return (
    <span className="texts-line ac-text-caption">
      {lang("kk", texts.kk)}
      {lang("en", texts.en)}
    </span>
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
