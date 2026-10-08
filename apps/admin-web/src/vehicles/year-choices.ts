import { latestVehicleYear } from "@adclub/domain";

/**
 * The years of a generation and a modification as a list (TASK-035.C,
 * D-071): from the current year down to `FIRST_LISTED_YEAR`, never a
 * future one (a year of production — «год выпуска» of a Kazakh
 * registration certificate). The current year is Almaty's and is read when
 * the list is drawn, so a new year starts the list by itself. The server
 * decides what is allowed (ARCHITECTURE 4.24 I217, 4.55); the list only
 * offers it.
 */

/** The oldest year the admin panel offers: older ones come only by a file. */
export const FIRST_LISTED_YEAR = 2000;

/**
 * The years to offer, newest first: `from`…`to` (by default 2000…the
 * current year), plus the record's own years outside of them (`keep`) —
 * a 1998 from an import stays shown and is saved as it is, never lost.
 */
export function yearChoices(
  options: {
    from?: number;
    to?: number | null;
    keep?: readonly (number | null | undefined)[];
  } = {},
  at: Date = new Date(),
): number[] {
  const latest = latestVehicleYear(at);
  const to = Math.min(options.to ?? latest, latest);
  const from = options.from ?? FIRST_LISTED_YEAR;
  const years = new Set<number>();
  for (let year = to; year >= from; year -= 1) years.add(year);
  for (const year of options.keep ?? []) {
    if (year != null) years.add(year);
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * The years a modification may have: its generation's (an open end — up to
 * the current year), whatever the generation's first year is, since the
 * server keeps a modification within it.
 */
export function modificationYearChoices(
  generation: { yearFrom: number; yearTo: number | null },
  keep: readonly (number | null | undefined)[] = [],
  at: Date = new Date(),
): number[] {
  return yearChoices({ from: generation.yearFrom, to: generation.yearTo, keep }, at);
}

/** The value of a year `<select>`: `""` — none (the first «Выберите» / «по настоящее время»). */
export const yearValue = (year: number | null | undefined): string =>
  year == null ? "" : String(year);

/** A year `<select>`'s value back: `null` for `""`. */
export const yearFromValue = (value: string): number | null => (value ? Number(value) : null);
