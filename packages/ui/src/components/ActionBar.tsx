import { Children, type ReactNode } from "react";
import { toastObstacle } from "./feedback";
import { cx } from "./cx";

export interface ActionBarProps {
  /** The main action of the screen (one per screen, DESIGN.md 7.7); usually a primary `Button`. */
  main?: ReactNode;
  /**
   * The other actions in reading order: secondary buttons, «Отказать» as a
   * secondary button with `destructive` text. `null`/`false` entries are skipped.
   */
  others?: readonly ReactNode[];
  /**
   * Stays at the bottom of the screen on a phone and a tablet: above the
   * bottom tabs and clear of the raised center button (C2); on a computer it
   * simply ends the content.
   */
  pinned?: boolean;
  /**
   * Buttons M 44 instead of L 52: actions inside a card («Позвонить ·
   * Написать в WhatsApp»), not the actions of the screen.
   */
  compact?: boolean;
  /**
   * The buttons in a column at any width — the side column of a computer
   * page (S-ORD-02 from 1024 px).
   */
  stacked?: boolean;
  /** A line under the buttons: why they wait («Нужна сеть», «Выберите…»). */
  note?: ReactNode;
  /** Accessible name of the group, e.g. «Действия с заявкой». */
  label?: string;
  className?: string;
}

/**
 * The actions of a screen or a card (TASK-079, C1). Under 600 px — a
 * column: the main action across the whole width on top; under it two
 * others side by side in halves, one or three and more — each across the
 * whole width. From 600 px — one row on the right, the main action last.
 * The buttons never shrink to their text on a phone and never wrap one by
 * one into a ragged row.
 */
export function ActionBar({
  main,
  others = [],
  pinned = false,
  compact = false,
  stacked = false,
  note,
  label,
  className,
}: ActionBarProps) {
  // `null`, `false` and `undefined` entries drop out here.
  const rest = Children.toArray(others);
  const hasMain = main !== undefined && main !== null && main !== false;
  if (!hasMain && rest.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={label}
      className={cx(
        "ac-action-bar",
        `ac-action-bar--others-${Math.min(rest.length, 3)}`,
        hasMain && "ac-action-bar--main",
        pinned && "ac-action-bar--pinned",
        compact && "ac-action-bar--compact",
        stacked && "ac-action-bar--stacked",
        className,
      )}
      {...(pinned ? toastObstacle : {})}
    >
      <div className="ac-action-bar__buttons">
        {hasMain && <div className="ac-action-bar__main">{main}</div>}
        {rest.length > 0 && <div className="ac-action-bar__others">{rest}</div>}
      </div>
      {note && <p className="ac-action-bar__note">{note}</p>}
    </div>
  );
}
