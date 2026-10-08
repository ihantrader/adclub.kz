import { describe, expect, it } from "vitest";
import {
  FIRST_LISTED_YEAR,
  modificationYearChoices,
  yearChoices,
  yearFromValue,
  yearValue,
} from "./year-choices";

const OCT_2026 = new Date("2026-10-08T12:00:00Z");

describe("year lists of the vehicle catalog (TASK-035.C)", () => {
  it("offers the current year down to 2000, newest first", () => {
    const years = yearChoices({}, OCT_2026);
    expect(years[0]).toBe(2026);
    expect(years.at(-1)).toBe(FIRST_LISTED_YEAR);
    expect(years).toHaveLength(27);
    expect(years).toEqual([...years].sort((a, b) => b - a));
  });

  it("starts with the new year by itself, in Almaty time", () => {
    // 2026-12-31 19:30 UTC is already 2027 in Almaty.
    expect(yearChoices({}, new Date("2026-12-31T19:30:00Z"))[0]).toBe(2027);
    expect(yearChoices({}, new Date("2026-12-31T18:30:00Z"))[0]).toBe(2026);
  });

  it("never offers a future year, even for a generation that names one", () => {
    expect(modificationYearChoices({ yearFrom: 2025, yearTo: 2030 }, [], OCT_2026)).toEqual([
      2026, 2025,
    ]);
  });

  it("keeps a modification within its generation's years", () => {
    expect(modificationYearChoices({ yearFrom: 2016, yearTo: 2019 }, [], OCT_2026)).toEqual([
      2019, 2018, 2017, 2016,
    ]);
    expect(modificationYearChoices({ yearFrom: 2024, yearTo: null }, [], OCT_2026)).toEqual([
      2026, 2025, 2024,
    ]);
  });

  it("keeps a record's own year outside the list, so it is shown and saved as it is", () => {
    // A 1998 that came by a file: neither lost nor replaced.
    const years = yearChoices({ keep: [1998, null] }, OCT_2026);
    expect(years.at(-1)).toBe(1998);
    expect(years).toContain(2000);
    expect(years).not.toContain(1999);
    // A generation of 1996–2004 offers its own years, below 2000 too.
    expect(modificationYearChoices({ yearFrom: 1996, yearTo: 2004 }, [], OCT_2026)).toEqual([
      2004, 2003, 2002, 2001, 2000, 1999, 1998, 1997, 1996,
    ]);
    // A later year a record already has (written before the rule) stays too.
    expect(yearChoices({ keep: [2028] }, OCT_2026)[0]).toBe(2028);
  });

  it("turns select values to years and back, empty — none", () => {
    expect(yearValue(null)).toBe("");
    expect(yearValue(2019)).toBe("2019");
    expect(yearFromValue("")).toBeNull();
    expect(yearFromValue("1998")).toBe(1998);
  });
});
