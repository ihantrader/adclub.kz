/**
 * Where a toast stands and how long it stays (DESIGN.md 7.7 «Всплывающее
 * сообщение», remark of the Product Owner of 05.10.2026; TASK-032,
 * ARCHITECTURE 4.48). One rule for the web and the app:
 *
 * - it stands **above** whatever is pinned to the bottom of the screen —
 *   the bottom tabs (with a raised center button), the pinned main button
 *   of a screen — with a gap of 8, and never covers the navigation or the
 *   main action;
 * - without anything pinned there — above the system safe area, gap 8;
 * - on a computer — at the bottom, centered on the content area (the web
 *   measures that area; the app has none).
 *
 * The platforms measure the top edge of each pinned element on screen and
 * pass them here; the rule itself has no idea what a tab bar is.
 */

/** The gap between the toast and what it stands above. */
export const TOAST_GAP = 8;

/**
 * How long a toast with an action («Сохранено · Отменить») stays when
 * nobody looks at it. A plain confirmation stays `motion.toast` (4 s); an
 * action has to be read, understood and reached with a thumb, so it gets
 * twice as long — and while it is looked at (pointer over it, focus inside
 * it, a finger on it, the page in the background) it does not go at all.
 */
export const TOAST_ACTION_LIFETIME = 8000;

/**
 * How far from the bottom edge of the viewport the toast's bottom edge must
 * stay, gap included: above the highest of the pinned elements, given by
 * their top edges (in the viewport's coordinates, the bottom edge at
 * `viewportHeight`). Elements that are not on screen — hidden, outside the
 * viewport — are left out by the caller or here (a top at or below the
 * bottom edge). `null` — nothing pinned: the platform puts the toast above
 * its safe area.
 */
export function toastBottomOffset(
  viewportHeight: number,
  pinnedTops: readonly number[],
): number | null {
  const onScreen = pinnedTops.filter((top) => Number.isFinite(top) && top < viewportHeight);
  if (onScreen.length === 0) return null;
  const highest = Math.max(0, Math.min(...onScreen));
  return viewportHeight - highest + TOAST_GAP;
}
