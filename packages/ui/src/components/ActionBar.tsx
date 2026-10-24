import { Children, useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { fitsInHalves } from "./action-bar-core";
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

/** The two hidden copies against the container; until both are laid out — not in halves. */
function measureHalves(others: HTMLElement | null, copies: HTMLElement | null): boolean {
  const items = copies?.children;
  if (!others || !items || items.length !== 2) return false;
  const width = (item: Element) => item.getBoundingClientRect().width;
  return fitsInHalves(others.getBoundingClientRect().width, [width(items[0]!), width(items[1]!)]);
}

const noSubscription = () => () => {};

/**
 * Whether the two secondary actions stand in halves (TASK-079.A): their own
 * one-line widths, measured on hidden copies, against the width of the
 * bar's container — never the window. The layout is the store: measured on
 * every render once both elements are in place (before the first paint),
 * and again whenever the container or a copy changes size (the width of the
 * page, a webfont, a language).
 */
function useHalves(others: HTMLElement | null, copies: HTMLElement | null): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!others || !copies || typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(notify);
      observer.observe(others);
      for (const item of Array.from(copies.children)) observer.observe(item);
      return () => observer.disconnect();
    },
    [others, copies],
  );
  return useSyncExternalStore(
    others && copies ? subscribe : noSubscription,
    () => measureHalves(others, copies),
    () => false,
  );
}

/**
 * The actions of a screen or a card (TASK-079, C1; TASK-079.A). A column:
 * the main action across the whole width on top; under it two others side
 * by side in halves while the label of each fits its half in one line,
 * otherwise — like one or three and more — each across the whole width.
 * The decision is by the bar's own container: the narrow side column of a
 * wide page is a column too. From 600 px a bar is one row on the right, the
 * main action last, buttons by their text — except a `stacked` one and two
 * actions of a card with no main action, which stay a column. A label never
 * wraps, so a button is never taller than its size.
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
  const pair = rest.length === 2;
  // The elements as state (callback refs): measuring them is reading the store, not a ref.
  const [othersBox, setOthersBox] = useState<HTMLDivElement | null>(null);
  const [copiesBox, setCopiesBox] = useState<HTMLDivElement | null>(null);
  const halves = useHalves(othersBox, copiesBox);
  if (!hasMain && rest.length === 0) return null;
  // A column at any width: a side column, and a pair of a card with no main
  // action («Позвонить · Написать в WhatsApp» across the card, TASK-079.A).
  const column = stacked || (!hasMain && pair);
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
        column && "ac-action-bar--column",
        className,
      )}
      {...(pinned ? toastObstacle : {})}
    >
      <div className="ac-action-bar__buttons">
        {hasMain && <div className="ac-action-bar__main">{main}</div>}
        {rest.length > 0 && (
          <div
            ref={setOthersBox}
            className={cx("ac-action-bar__others", halves && "ac-action-bar__others--halves")}
          >
            {rest}
          </div>
        )}
      </div>
      {note && <p className="ac-action-bar__note">{note}</p>}
      {pair && (
        <div ref={setCopiesBox} className="ac-action-bar__measure" aria-hidden="true" inert>
          {rest.map((node, index) => (
            <div key={index} className="ac-action-bar__measure-item">
              {node}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
