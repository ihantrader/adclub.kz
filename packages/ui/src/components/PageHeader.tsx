import type { MouseEvent, ReactNode } from "react";
import { cx } from "./cx";

/** A step of the way to a page: «Справочник › Позиции». */
export interface Crumb {
  label: string;
  href: string;
}

export interface PageTab<K extends string> {
  key: K;
  label: string;
  href: string;
  /** «Сотрудники 4» — a count after the word; `null`/`undefined` — none. */
  count?: number | null;
}

export interface PageHeaderProps<K extends string> {
  /** Where the page lies; on a page of an object — instead of the tabs of its section (X11). */
  crumbs?: readonly Crumb[];
  /** The name of the section or of the object; never the name of a tab. */
  title: ReactNode;
  /** Right of the title: the page's actions, one size (TASK-080, X13). */
  actions?: ReactNode;
  /** Under the title: the object's status badge, its facts in one line. */
  subtitle?: ReactNode;
  /** One bar of tabs, at most: the sections of a list, or the tabs of an object. */
  tabs?: { label: string; items: readonly PageTab<K>[]; active: K | null };
  /**
   * In-app navigation of the links (crumbs and tabs); a click with a
   * modifier or not with the main button is left to the browser (new tab).
   */
  onNavigate?: (href: string) => void;
}

function follow(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate: ((href: string) => void) | undefined,
) {
  if (!onNavigate) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  onNavigate(href);
}

/**
 * The head of every page of the admin panel (TASK-080, X11): crumbs →
 * the title (`titleL`) on the left and the actions on the right → the
 * subtitle (status, facts) → one bar of tabs. Every page puts its title at
 * the same height; a page of an object shows the crumbs of its section, not
 * the section's tabs, so there is never a second bar.
 */
export function PageHeader<K extends string>({
  crumbs,
  title,
  actions,
  subtitle,
  tabs,
  onNavigate,
}: PageHeaderProps<K>) {
  return (
    <header className={cx("ac-page-header", tabs && "ac-page-header--tabs")}>
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Путь к странице">
          <ol className="ac-crumbs">
            {crumbs.map((crumb) => (
              <li key={crumb.href}>
                <a href={crumb.href} onClick={(event) => follow(event, crumb.href, onNavigate)}>
                  {crumb.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="ac-page-header__row">
        <h1 className="ac-page-header__title">{title}</h1>
        {actions && <div className="ac-page-header__actions">{actions}</div>}
      </div>
      {subtitle && <div className="ac-page-header__subtitle">{subtitle}</div>}
      {tabs && (
        <nav className="ac-page-tabs" aria-label={tabs.label}>
          {tabs.items.map((tab) => (
            <a
              key={tab.key}
              href={tab.href}
              className={cx(
                "ac-page-tabs__tab",
                tab.key === tabs.active && "ac-page-tabs__tab--on",
              )}
              aria-current={tab.key === tabs.active ? "page" : undefined}
              onClick={(event) => follow(event, tab.href, onNavigate)}
            >
              {tab.label}
              {tab.count !== undefined && tab.count !== null && (
                <span className="ac-page-tabs__count">{tab.count.toLocaleString("ru-RU")}</span>
              )}
            </a>
          ))}
        </nav>
      )}
    </header>
  );
}

export interface TableToolbarProps {
  /** «Всего 22»; `null` — not shown (nothing found: the empty state says it). */
  total?: number | null;
  /** «Всего» — the word before the count. */
  totalLabel?: string;
  /** Right: «Сбросить фильтры», a sort. */
  children?: ReactNode;
}

/**
 * The line between the filters and a table (TASK-080, X12): «Всего 22»
 * `textMuted` on the left, the reset of the filters on the right, 12 from
 * the table — the count belongs to the table, not to the filters.
 */
export function TableToolbar({ total, totalLabel = "Всего", children }: TableToolbarProps) {
  if ((total === null || total === undefined) && !children) return null;
  return (
    <div className="ac-table-toolbar">
      {total !== null && total !== undefined ? (
        <span className="ac-table-toolbar__total" role="status">
          {totalLabel} {total.toLocaleString("ru-RU")}
        </span>
      ) : (
        <span />
      )}
      {children && <div className="ac-table-toolbar__actions">{children}</div>}
    </div>
  );
}
