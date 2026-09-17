import {
  compatibilityMarks,
  orderStatusGroups,
  type Compatibility,
  type IconName,
  type OrderStatusGroup,
  type Tone,
} from "@adclub/ui-core";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";

export interface BadgeProps {
  tone: Tone;
  icon: IconName;
  children: ReactNode;
}

/** Badge on a role background: `captionStrong`, radius 4, icon 16 + text (DESIGN.md 7.7). */
export function Badge({ tone, icon, children }: BadgeProps) {
  return (
    <span className={cx("ac-badge", `ac-badge--${tone}`)}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </span>
  );
}

/** Order status badge: group color + icon + text (DESIGN.md 7.8). */
export function StatusBadge({ group, children }: { group: OrderStatusGroup; children: ReactNode }) {
  const { tone, icon } = orderStatusGroups[group];
  return (
    <Badge tone={tone} icon={icon}>
      {children}
    </Badge>
  );
}

/** Compatibility mark: icon 16 + text, never color alone (DESIGN.md 7.8). */
export function CompatibilityMark({
  value,
  children,
}: {
  value: Compatibility;
  children: ReactNode;
}) {
  const { icon } = compatibilityMarks[value];
  return (
    <span className={cx("ac-compat", `ac-compat--${value}`)}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </span>
  );
}

/** "распознано" / "предложено ИИ": sparkles + text in the AI color (DESIGN.md 7.9). */
export function AiBadge({ children }: { children: ReactNode }) {
  return (
    <span className="ac-ai-badge">
      <Icon name="sparkles" size={16} />
      <span>{children}</span>
    </span>
  );
}

export interface RatingProps {
  /** Average score; `null` — no reviews yet. */
  value: number | null;
  count: number;
  /** T-CAT-07 text when there are no reviews. */
  emptyText: string;
  /** Screen reader text, e.g. "Рейтинг 4,8 из 5, 23 оценки". */
  label: string;
  locale: string;
}

export function Rating({ value, count, emptyText, label, locale }: RatingProps) {
  if (value === null) return <span className="ac-rating ac-rating--empty">{emptyText}</span>;
  const score = value.toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return (
    <span className="ac-rating" role="img" aria-label={label}>
      <Icon name="star" size={16} filled />
      <span aria-hidden="true">
        {score} ({count.toLocaleString(locale)})
      </span>
    </span>
  );
}
