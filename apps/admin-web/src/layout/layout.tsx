import { Icon, PageHeader, type PageHeaderProps } from "@adclub/ui";
import type { IconName } from "@adclub/ui-core";
import type { MouseEvent, ReactNode } from "react";
import { navigateTo } from "../router";

/**
 * The parts every page of the admin panel is built of (TASK-080): the head
 * of a page, the links of a row, the dense table with fixed columns, the
 * thumbnail of an item. A page arranges them; it does not draw its own.
 */

/** A plain left click on a link goes through the admin panel's router; the rest is the browser's. */
export function follow(event: MouseEvent, href: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  navigateTo(href);
}

/** A link inside the admin panel (`accent`, underlined on hover — X1). */
export function AppLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a href={href} className={className} onClick={(event) => follow(event, href)}>
      {children}
    </a>
  );
}

/** The head of a page (`PageHeader` of `@adclub/ui`) with the admin panel's router. */
export function Header<K extends string>(props: Omit<PageHeaderProps<K>, "onNavigate">) {
  return <PageHeader<K> {...props} onNavigate={(href) => navigateTo(href)} />;
}

/**
 * The name of the object in the first cell of a row (X1): `text`
 * `bodyStrong`, `accent` on hover — a link for the keyboard and for «open in
 * a new tab»; the whole row leads there too (`rowLink`).
 */
export function RowTitle({
  href,
  children,
  sub,
}: {
  href: string;
  children: ReactNode;
  /** A muted line under the name: the brand and the article, the BIN. */
  sub?: ReactNode;
}) {
  return (
    <span className="row-title">
      <a href={href} className="row-title__link" onClick={(event) => follow(event, href)}>
        {children}
      </a>
      {sub && <span className="row-title__sub">{sub}</span>}
    </span>
  );
}

function interactive(target: EventTarget | null, row: Element): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== row) {
    if (
      node.matches("a, button, input, select, textarea, label, [role='combobox'], [role='menu']")
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * A row that leads to its object (X1: the row is the link, not three
 * columns): a click anywhere but on a control of the row opens it; with
 * Ctrl or ⌘ — in a new tab; a selection of text is left alone.
 */
export function rowLink(href: string) {
  return {
    className: "row--link",
    onClick: (event: MouseEvent<HTMLTableRowElement>) => {
      if (interactive(event.target, event.currentTarget)) return;
      if ((window.getSelection()?.toString() ?? "") !== "") return;
      if (event.metaKey || event.ctrlKey) {
        window.open(href, "_blank", "noopener");
        return;
      }
      navigateTo(href);
    },
  };
}

export interface Column {
  key: string;
  header: ReactNode;
  /** A fixed width in px; without it — the flexible column (the name, the text). */
  width?: number;
  /** Right-aligned with its header, `tabular-nums` (X8). */
  numeric?: boolean;
  /** The column of row actions: as wide as its content (X6). */
  actions?: boolean;
  /** The header for screen readers only (the actions). */
  hiddenHeader?: boolean;
}

/** Each flexible column needs at least this much before the table scrolls sideways. */
const FLEX_MIN = 240;

/**
 * A dense table of the admin panel (DESIGN 7.13, X20): rows 40–48, fixed
 * columns — the same widths on every tab of one list — sums, dates, numbers
 * and statuses in one line, only the name or the text wraps. Narrower than
 * its columns, it scrolls sideways inside its frame with the first column
 * held in place; the page never does.
 */
export function Table({
  label,
  columns,
  children,
  className,
}: {
  label: string;
  columns: readonly Column[];
  children: ReactNode;
  className?: string;
}) {
  const minWidth = columns.reduce((sum, column) => sum + (column.width ?? FLEX_MIN), 0);
  return (
    <div className="table-wrap">
      <table
        className={
          className
            ? `admin-table admin-table--fixed ${className}`
            : "admin-table admin-table--fixed"
        }
        style={{ minWidth }}
      >
        <caption className="ac-visually-hidden">{label}</caption>
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={
                  column.numeric ? "num" : column.actions ? "admin-table__actions" : undefined
                }
              >
                {column.hiddenHeader ? (
                  <span className="ac-visually-hidden">{column.header}</span>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/**
 * The photo of an item, or its placeholder (X17): an icon on `surfaceRaised`,
 * never an empty beige square.
 */
export function Thumb({
  src,
  size = 40,
  icon = "image",
  alt = "",
}: {
  src?: string | null;
  size?: 40 | 48 | 72 | 160;
  icon?: IconName;
  alt?: string;
}) {
  if (src) {
    return <img className={`thumb thumb--${String(size)}`} src={src} alt={alt} loading="lazy" />;
  }
  return (
    <span className={`thumb thumb--${String(size)} thumb--empty`} aria-hidden="true">
      <Icon name={icon} size={size >= 72 ? 24 : 20} />
    </span>
  );
}

/** «Значение» — `textMuted`, an empty value as a dash. */
export function Muted({ children }: { children: ReactNode }) {
  return <span className="ac-muted">{children}</span>;
}
