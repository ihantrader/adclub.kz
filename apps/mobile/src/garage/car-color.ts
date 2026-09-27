/**
 * The colour of a car in the garage (D-063, TASK-028.B): a fixed list kept in
 * the code, not the server — it never changes the compatibility of a single
 * item, so it needs no migration and no admin screen. A garage saved before
 * this list existed has no colour for its cars, and reads back with `null`
 * (`garage.ts`'s `parseCar`) exactly like any other level a car has not been
 * given yet: "Не указан" is a normal state, not an error.
 *
 * The swatch is a real paint-like hex, not a `ColorToken` of DESIGN 7.2 — the
 * design system's tokens name interface roles (`accent`, `danger`, …), and a
 * car's colour is not one of those roles.
 */
export type CarColorId =
  | "white"
  | "black"
  | "gray"
  | "silver"
  | "blue"
  | "darkBlue"
  | "red"
  | "green"
  | "brown"
  | "beige"
  | "orange"
  | "yellow"
  | "burgundy";

export interface CarColorOption {
  id: CarColorId;
  swatch: string;
}

export const CAR_COLORS: readonly CarColorOption[] = [
  { id: "white", swatch: "#F2F1ED" },
  { id: "black", swatch: "#1A1A1A" },
  { id: "gray", swatch: "#8A8D91" },
  { id: "silver", swatch: "#C8CACD" },
  { id: "blue", swatch: "#2B5797" },
  { id: "darkBlue", swatch: "#152238" },
  { id: "red", swatch: "#B3261E" },
  { id: "green", swatch: "#2E5339" },
  { id: "brown", swatch: "#5A3E2B" },
  { id: "beige", swatch: "#D8CBB0" },
  { id: "orange", swatch: "#C9622A" },
  { id: "yellow", swatch: "#D9B23C" },
  { id: "burgundy", swatch: "#6D1B2E" },
];

const IDS = new Set<string>(CAR_COLORS.map((option) => option.id));

/** Whether a value read back from storage is one of today's colours. */
export function isCarColorId(value: unknown): value is CarColorId {
  return typeof value === "string" && IDS.has(value);
}

export function findCarColor(id: CarColorId | null): CarColorOption | null {
  if (id === null) return null;
  return CAR_COLORS.find((option) => option.id === id) ?? null;
}
