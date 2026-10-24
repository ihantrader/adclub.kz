/** The logic of «Выбор из списка» (TASK-080, `Select`): pure, tested without a DOM. */

export interface SelectChoice<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** How long typed letters add up to one search («ал» — «Алматы»), as in a native select. */
export const TYPEAHEAD_RESET_MS = 700;

/** The keys that move the highlighted option of an open list. */
export type SelectMove = "next" | "previous" | "first" | "last" | "pageDown" | "pageUp";

const PAGE = 10;

/** The next enabled option from `from` in a direction; `from` itself when there is none. */
function step<T extends string>(
  options: readonly SelectChoice<T>[],
  from: number,
  direction: 1 | -1,
): number {
  for (let index = from + direction; index >= 0 && index < options.length; index += direction) {
    if (!options[index]?.disabled) return index;
  }
  return from;
}

/** Where the highlight goes; disabled options are skipped, the ends do not wrap. */
export function moveHighlight<T extends string>(
  options: readonly SelectChoice<T>[],
  active: number,
  move: SelectMove,
): number {
  switch (move) {
    case "next":
      return active < 0 ? step(options, -1, 1) : step(options, active, 1);
    case "previous":
      return active < 0 ? step(options, options.length, -1) : step(options, active, -1);
    case "first":
      return step(options, -1, 1);
    case "last":
      return step(options, options.length, -1);
    case "pageDown": {
      let index = active < 0 ? -1 : active;
      for (let i = 0; i < PAGE; i++) index = step(options, index, 1);
      return index;
    }
    case "pageUp": {
      let index = active < 0 ? options.length : active;
      for (let i = 0; i < PAGE; i++) index = step(options, index, -1);
      return index;
    }
  }
}

/** The move of a key, or `null` when the key does not move the highlight. */
export function moveOfKey(key: string): SelectMove | null {
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "PageDown":
      return "pageDown";
    case "PageUp":
      return "pageUp";
    default:
      return null;
  }
}

/** A key that types (a letter, a digit) — not Space, which opens and chooses. */
export function isTypingKey(key: string): boolean {
  return key.length === 1 && key !== " ";
}

/**
 * Type-ahead (the first letters, as in a native select): the next enabled
 * option after `from` whose label starts with `typed`, wrapping round; one
 * letter typed again moves through the options of that letter. `-1` — none.
 */
export function typeahead<T extends string>(
  options: readonly SelectChoice<T>[],
  from: number,
  typed: string,
): number {
  if (!typed) return -1;
  const needle = typed.toLocaleLowerCase("ru");
  const repeated = needle.length > 1 && [...needle].every((char) => char === needle[0]);
  const search = repeated ? needle[0]! : needle;
  // The same option keeps matching while more letters are typed.
  const start = repeated || needle.length === 1 ? from + 1 : Math.max(from, 0);
  for (let offset = 0; offset < options.length; offset++) {
    const index = (start + offset) % options.length;
    const option = options[index];
    if (option && !option.disabled && option.label.toLocaleLowerCase("ru").startsWith(search)) {
      return index;
    }
  }
  return -1;
}
