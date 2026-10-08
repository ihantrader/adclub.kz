/**
 * The rules of «выбор с поиском» without React (TASK-035.B): what is asked
 * of the server for what is typed, and how the keyboard moves through the
 * found entries. One component uses them everywhere a list is too long to
 * load whole — makes, models, generations, engines, brands.
 */

/** One entry to choose. */
export interface Choice {
  id: string;
  /** What the field shows once chosen. */
  label: string;
  /** A second line in the list: other spellings, years, «в архиве». */
  note?: string | null;
  /** Archived and the like: shown, but muted. */
  muted?: boolean;
}

/** Characters typed before the server is searched; less — the first entries are shown. */
export const SEARCH_MIN_CHARS = 1;

/** A moment after typing stops before the server is asked. */
export const SEARCH_DEBOUNCE_MS = 200;

/** How many entries one answer shows: the rest are found by typing more. */
export const SEARCH_PAGE = 20;

/**
 * The query for the server: trimmed, inner spaces collapsed (the server
 * ignores case and spaces of spellings anyway); `""` — too short, show the
 * first entries instead.
 */
export function searchQuery(text: string): string {
  const query = text.trim().replace(/\s+/g, " ");
  return [...query].length >= SEARCH_MIN_CHARS ? query : "";
}

export type MoveKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";

export function isMoveKey(key: string): key is MoveKey {
  return ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(key);
}

/**
 * The entry highlighted after a key: arrows step and wrap around, Home and
 * End jump to the ends, pages step by five. `-1` — nothing highlighted
 * (the list is empty).
 */
export function moveActive(active: number, count: number, key: MoveKey): number {
  if (count <= 0) return -1;
  switch (key) {
    case "ArrowDown":
      return active < 0 || active >= count - 1 ? 0 : active + 1;
    case "ArrowUp":
      return active <= 0 ? count - 1 : active - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(count - 1, Math.max(active, 0) + 5);
    case "PageUp":
      return Math.max(0, active - 5);
  }
}

/**
 * The text of the «new value» entry (TASK-035.C): «Новый двигатель «3G15»»
 * with what is typed, the bare label while nothing is.
 */
export function createText(label: string, typed: string): string {
  return typed ? `${label} «${typed}»` : label;
}

/**
 * The entry highlighted when an answer comes. Typed — the best match, so
 * Enter takes it; typed and nothing found — the «new value» entry (it is
 * the only one, at index 0), so Enter opens its form; browsing — nothing.
 */
export function firstActive(options: {
  typed: boolean;
  found: number;
  canCreate: boolean;
}): number {
  if (!options.typed) return -1;
  return options.found > 0 || options.canCreate ? 0 : -1;
}

/**
 * The entries a list shows: `empty` (the «Любой» / «Все» entry, choosing
 * nothing) first while nothing is typed, then the found ones; the chosen
 * one stays findable even when it is not among them (archived, or beyond
 * the first page), so the field never loses it silently.
 */
export function listed(
  found: readonly Choice[],
  options: { typed: boolean; empty?: string | null; chosen?: Choice | null },
): (Choice | null)[] {
  const entries: (Choice | null)[] = [];
  if (options.empty && !options.typed) entries.push(null);
  const chosen = options.chosen;
  if (chosen && !options.typed && !found.some((entry) => entry.id === chosen.id)) {
    entries.push(chosen);
  }
  entries.push(...found);
  return entries;
}
