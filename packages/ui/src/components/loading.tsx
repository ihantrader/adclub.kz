import { contentSwap, createLoadingGate, type ContentSwap } from "@adclub/ui-core";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { cx } from "./cx";

/**
 * Loading without flicker on the web (DESIGN 7.6 «Загрузка без мигания»,
 * D-069, TASK-032.A). The rule — the delay, the minimum, «only the last
 * load» — is `createLoadingGate` of `@adclub/ui-core`; this file only turns
 * it into React hooks and the components screens are built from, so no
 * screen keeps a timer of its own.
 */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduce(listener: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(REDUCE_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** The system's «Уменьшить движение» (`prefers-reduced-motion`). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduce,
    () => typeof window !== "undefined" && !!window.matchMedia?.(REDUCE_QUERY).matches,
    () => false,
  );
}

/** How new content takes the place of the old one, under the system's setting. */
export function useContentSwap(): ContentSwap {
  const reduce = useReducedMotion();
  return useMemo(() => contentSwap(reduce), [reduce]);
}

export interface LoadingGateHandle {
  /** The loading indicator is on screen (after the delay, for at least its minimum). */
  indicator: boolean;
  /** A load waits for its answer, or its answer for its moment. */
  pending: boolean;
  /** A load starts; an earlier one whose answer is not on screen yet no longer counts. */
  begin: () => number;
  /** Puts the answer of `ticket` on screen (`show`) when the rule allows; a stale ticket is ignored. */
  settle: (ticket: number, show: () => void) => void;
  /** Nothing more to wait for. */
  cancel: () => void;
}

/**
 * One place of a screen that waits — a list, a card. Answers (and errors)
 * are applied through `settle`, never directly: a quick one at once, one
 * that made the indicator appear — when it has been seen its minimum, in
 * the same render the indicator goes away.
 */
export function useLoadingGate(): LoadingGateHandle {
  const [gate] = useState(() => createLoadingGate());
  const indicator = useSyncExternalStore(
    gate.subscribe,
    () => gate.indicator,
    () => false,
  );
  const pending = useSyncExternalStore(
    gate.subscribe,
    () => gate.pending,
    () => false,
  );
  useEffect(() => () => gate.dispose(), [gate]);
  return useMemo(
    () => ({
      indicator,
      pending,
      begin: gate.begin,
      settle: gate.settle,
      cancel: gate.cancel,
    }),
    [gate, indicator, pending],
  );
}

/**
 * The indicator for something that is simply busy — a button that saves,
 * the start of the page: on after the delay, then on for at least the
 * minimum, whatever `active` does in the meantime.
 */
export function useDelayedIndicator(active: boolean): boolean {
  const gate = useLoadingGate();
  const { begin, settle } = gate;
  useEffect(() => {
    if (!active) return;
    const ticket = begin();
    return () => settle(ticket, () => undefined);
  }, [active, begin, settle]);
  return gate.indicator;
}

/**
 * The thin line of a refresh over content that stays (SCREENS 2.1): 2 px,
 * always in the layout, so it never pushes the content down and back. Still,
 * without its sweep, under «Уменьшить движение».
 */
export function RefreshLine({ active, label }: { active: boolean; label?: string }) {
  return (
    <div
      className={cx("ac-refresh-line", active && "ac-refresh-line--active")}
      {...(active ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    >
      {active && <span className="ac-refresh-line__bar" />}
    </div>
  );
}

/**
 * Fades an element in from `from` by the swap rule — nothing under
 * «Уменьшить движение». Web Animations, so the element is not remounted and
 * keeps its state (a field being typed in, a scroll position).
 */
function useFadeIn(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  /** Where to start: an element that just appeared, or the same one with new content. */
  from: (appeared: boolean, swap: ContentSwap) => number,
) {
  const swap = useContentSwap();
  const seen = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const appeared = element !== seen.current;
    seen.current = element;
    if (!element || !swap.fades || typeof element.animate !== "function") return;
    const opacity = from(appeared, swap);
    if (opacity >= 1) return;
    element.animate([{ opacity }, { opacity: 1 }], {
      duration: swap.durationMs,
      easing: `cubic-bezier(${swap.easing.join(", ")})`,
    });
    // Only a new key fades; the rule and `from` are this render's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export interface LoadingContentProps {
  /** There is content to show: the first answer has arrived. */
  ready: boolean;
  /** The indicator of the place's gate (`useLoadingGate().indicator`). */
  indicator: boolean;
  /**
   * The skeleton of the first load, repeating the real layout. Its place is
   * kept from the start, but it is seen only once the indicator appears — a
   * quick first answer comes with no skeleton at all.
   */
  skeleton: ReactNode;
  /** Screen reader text of the refresh line («Загрузка»). */
  label: string;
  /**
   * Changes when other content takes the place of what is shown (another
   * tab, filter, query): the new content fades in from the dimmed old one.
   * Edits of the same content (a saved row) keep it and do not fade.
   */
  swapKey?: string | number;
  /**
   * While a reload is visible, the old content cannot be acted on — fields
   * and buttons over data that is about to go away (`inert`). For content
   * where acting on the old data is harmless, leave it off.
   */
  lock?: boolean;
  /** Shown above the content without taking it away: an error of the reload with «Повторить». */
  notice?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * «Содержимое с загрузкой»: the first load — the skeleton after the delay;
 * every load after it — the previous content stays where it is, dimmed under
 * the refresh line, and the new one replaces it with a fade (DESIGN 7.6).
 * Heights do not jump: the line has its place, and the skeleton keeps its
 * place before it is seen.
 */
export function LoadingContent({
  ready,
  indicator,
  skeleton,
  label,
  swapKey,
  lock = false,
  notice,
  className,
  children,
}: LoadingContentProps) {
  const content = useRef<HTMLDivElement>(null);
  // New content starts where the old one was — dimmed under the line, and
  // from the same dimmed opacity after a quick answer too: a soft dissolve,
  // not a blink to nothing. The first content of the place appears from nothing.
  useFadeIn(content, ready ? (swapKey ?? "ready") : null, (appeared, swap) =>
    appeared ? 0 : swap.fromOpacity,
  );

  if (!ready) {
    return (
      <div
        className={cx("ac-first-load", indicator && "ac-first-load--shown", className)}
        aria-busy="true"
      >
        {skeleton}
      </div>
    );
  }
  const locked = lock && indicator;
  return (
    <div className={cx("ac-loading", className)}>
      <RefreshLine active={indicator} label={label} />
      {notice}
      <div
        ref={content}
        className={cx("ac-loading__content", indicator && "ac-loading__content--dim")}
        aria-busy={indicator || undefined}
        inert={locked || undefined}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Fades its content in whenever `fadeKey` changes — a page of the cabinet
 * taking the place of another (150 ms, nothing under «Уменьшить движение»).
 * Only what is inside fades: the header, the tabs and the side menu around
 * it stay as they are.
 */
export function FadeSwap({
  fadeKey,
  as: Tag = "div",
  className,
  children,
}: {
  fadeKey: string | number;
  /** `main` for the page of a frame. */
  as?: "div" | "main";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useFadeIn(ref, fadeKey, () => 0);
  return (
    <Tag ref={ref as RefObject<HTMLDivElement>} className={className}>
      {children}
    </Tag>
  );
}

/**
 * The delayed skeleton of something that has no content yet and is not a
 * `LoadingContent` (a page of its own while the cabinet starts): its place
 * kept, seen only after the delay.
 */
export function DelayedSkeleton({
  indicator,
  children,
}: {
  indicator: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx("ac-first-load", indicator && "ac-first-load--shown")} aria-busy="true">
      {children}
    </div>
  );
}
