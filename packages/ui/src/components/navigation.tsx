import { brandSvg, type BrandSvgName, type IconName } from "@adclub/ui-core";
import type { ReactNode } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./Icon";
import { cx } from "./cx";

export interface NavItem<K extends string> {
  key: K;
  label: string;
  icon: IconName;
  /** Counter badge, e.g. new orders. */
  count?: number;
  /** Screen reader text for the counter ("3 новые"). */
  countLabel?: string;
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export interface LogoProps {
  /** `auto` follows the theme: champagne on graphite, graphite on light (DESIGN.md 2). */
  variant?: "auto" | "champagne" | "graphite" | "white";
  /** Only the AD mark — widths under 48 px. */
  mark?: boolean;
  height?: number;
}

export function Logo({ variant = "auto", mark = false, height = 40 }: LogoProps) {
  const { theme } = useTheme();
  const color = variant === "auto" ? (theme.name === "dark" ? "champagne" : "graphite") : variant;
  const name: BrandSvgName = mark ? `mark-ad-${color}` : `logo-${color}`;
  const svg = brandSvg[name];
  return <img className="ac-logo" src={svgDataUri(svg)} alt="Asia Drive Club" height={height} />;
}

function Count({ value, label }: { value?: number; label?: string }) {
  if (!value) return null;
  return (
    <span className="ac-count" aria-label={label}>
      {value}
    </span>
  );
}

export interface SidebarProps<K extends string> {
  label: string;
  items: readonly NavItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  header?: ReactNode;
  footer?: ReactNode;
}

/** Cabinet navigation from 1024 px: 240 wide, `bar` background (DESIGN.md 7.5). */
export function Sidebar<K extends string>({
  label,
  items,
  active,
  onSelect,
  header,
  footer,
}: SidebarProps<K>) {
  return (
    <nav className="ac-sidebar" aria-label={label}>
      {header}
      <ul className="ac-sidebar__list">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className={cx("ac-nav-item", item.key === active && "ac-nav-item--on")}
              aria-current={item.key === active ? "page" : undefined}
              onClick={() => onSelect(item.key)}
            >
              <Icon name={item.icon} size={20} />
              <span className="ac-nav-item__label">{item.label}</span>
              <Count value={item.count} label={item.countLabel} />
            </button>
          </li>
        ))}
      </ul>
      {footer && <div className="ac-sidebar__footer">{footer}</div>}
    </nav>
  );
}

export interface BottomTabsProps<K extends string> {
  label: string;
  /** Tabs left and right of the center button, in order. */
  items: readonly NavItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  /** Raised center button ("Сканер" in the cabinet); inserted in the middle. */
  center?: { key: K; label: string; icon: IconName };
}

/** Phone tab bar: 64 + safe area, `bar` background, active tab — `accent` (7.7). */
export function BottomTabs<K extends string>({
  label,
  items,
  active,
  onSelect,
  center,
}: BottomTabsProps<K>) {
  const half = Math.ceil(items.length / 2);
  const tab = (item: NavItem<K>) => (
    <button
      key={item.key}
      type="button"
      className={cx("ac-tab", item.key === active && "ac-tab--on")}
      aria-current={item.key === active ? "page" : undefined}
      onClick={() => onSelect(item.key)}
    >
      <span className="ac-tab__icon">
        <Icon name={item.icon} size={24} />
        <Count value={item.count} label={item.countLabel} />
      </span>
      <span className="ac-tab__label">{item.label}</span>
    </button>
  );
  return (
    <nav className="ac-tabs" aria-label={label}>
      {items.slice(0, half).map(tab)}
      {center && (
        <button
          type="button"
          className={cx("ac-tab", "ac-tab--center", center.key === active && "ac-tab--on")}
          aria-current={center.key === active ? "page" : undefined}
          onClick={() => onSelect(center.key)}
        >
          <span className="ac-tab__center-button">
            <Icon name={center.icon} size={28} />
          </span>
          <span className="ac-tab__label">{center.label}</span>
        </button>
      )}
      {items.slice(half).map(tab)}
    </nav>
  );
}
