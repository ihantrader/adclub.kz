import { CAR_IDENTITY_LEVELS, type CarIdentityLevel } from "./same-car";

/**
 * One chosen level with the label the picker showed; the label is noise to
 * the rule, and the cases below vary it to prove that.
 */
export interface SameCarCaseLevel {
  readonly id: string;
  readonly label: string;
}

/** A car as the cases write it: the levels of the picker plus what is not part of the rule. */
export interface SameCarCaseCar {
  readonly make: SameCarCaseLevel;
  readonly model: SameCarCaseLevel;
  readonly year: number | null;
  readonly generation: SameCarCaseLevel | null;
  readonly body: SameCarCaseLevel | null;
  readonly engine: SameCarCaseLevel | null;
  readonly transmission: SameCarCaseLevel | null;
  readonly drive: SameCarCaseLevel | null;
  /** D-063; not a level, never part of the rule. */
  readonly color: string | null;
}

export interface SameCarCase {
  readonly name: string;
  readonly a: SameCarCaseCar;
  readonly b: SameCarCaseCar;
  readonly same: boolean;
}

const FULL: SameCarCaseCar = {
  make: { id: "make-geely", label: "Geely" },
  model: { id: "model-atlas", label: "Atlas" },
  year: 2023,
  generation: { id: "gen-2", label: "II (FX11)" },
  body: { id: "body-suv", label: "Внедорожник" },
  engine: { id: "engine-20t", label: "2.0T" },
  transmission: { id: "trans-at", label: "Автомат" },
  drive: { id: "drive-awd", label: "Полный" },
  color: "white",
};

const MINIMAL: SameCarCaseCar = {
  ...FULL,
  year: null,
  generation: null,
  body: null,
  engine: null,
  transmission: null,
  drive: null,
  color: null,
};

/** Another catalog entry for a level, to put in place of the one `FULL` has. */
function otherOf(level: CarIdentityLevel): Partial<SameCarCaseCar> {
  if (level === "year") {
    return { year: 2024 };
  }
  return { [level]: { id: `${level}-other`, label: `${level} other` } };
}

/**
 * The data both sides of the merge are held to — the app's `sameCar` over two
 * `GarageCar`s and the server's `sameLevels` over a row and the levels of a
 * car sent to it must give `same` on every one (TASK-029.A). Built from
 * `CAR_IDENTITY_LEVELS`, so a level added to the rule is a case here at
 * once, on both sides, with nobody having to remember to write it.
 */
export function sameCarCases(): SameCarCase[] {
  const cases: SameCarCase[] = [
    { name: "identical cars", a: FULL, b: { ...FULL }, same: true },
    {
      name: "labels differ (the catalog renamed something)",
      a: FULL,
      b: {
        ...FULL,
        make: { id: FULL.make.id, label: "GEELY Auto" },
        engine: { id: FULL.engine!.id, label: "2,0 л турбо" },
      },
      same: true,
    },
    { name: "colour differs", a: FULL, b: { ...FULL, color: "red" }, same: true },
    { name: "colour set against colour not set", a: FULL, b: { ...FULL, color: null }, same: true },
    { name: "only make and model known on both", a: MINIMAL, b: { ...MINIMAL }, same: true },
  ];
  for (const level of CAR_IDENTITY_LEVELS) {
    cases.push({
      name: `${level} is another catalog entry`,
      a: FULL,
      b: { ...FULL, ...otherOf(level) },
      same: false,
    });
    if (level !== "make" && level !== "model") {
      cases.push(
        {
          name: `${level} is chosen in one car and not in the other`,
          a: FULL,
          b: { ...FULL, [level]: null },
          same: false,
        },
        {
          name: `${level} is not chosen in the first car and is in the second`,
          a: { ...FULL, [level]: null },
          b: FULL,
          same: false,
        },
        {
          name: `${level} is not chosen in either`,
          a: { ...FULL, [level]: null },
          b: { ...FULL, [level]: null },
          same: true,
        },
      );
    }
  }
  return cases;
}
