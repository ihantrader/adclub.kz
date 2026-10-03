import { describe, expect, it } from "vitest";
import { sameCarCases } from "./same-car-cases";
import { CAR_IDENTITY_LEVELS, carIdentity, sameCar, sameCarIdentity } from "./same-car";

describe("the same car", () => {
  for (const { name, a, b, same } of sameCarCases()) {
    it(`${same ? "is" : "is not"} the same car when ${name}`, () => {
      expect(sameCar(a, b)).toBe(same);
      expect(sameCar(b, a)).toBe(same);
    });
  }

  it("has a case for every level of the picker that turns the answer", () => {
    const decisive = new Set(
      sameCarCases()
        .filter((entry) => !entry.same)
        .map((entry) => entry.name.split(" ")[0]),
    );
    expect([...decisive].sort()).toEqual([...CAR_IDENTITY_LEVELS].sort());
  });

  it("reduces a car to exactly the levels of the rule, whatever else it carries", () => {
    const [first] = sameCarCases();
    const identity = carIdentity(first!.a);
    expect(Object.keys(identity).sort()).toEqual([...CAR_IDENTITY_LEVELS].sort());
    expect(identity).toEqual({
      make: "make-geely",
      model: "model-atlas",
      year: 2023,
      generation: "gen-2",
      body: "body-suv",
      engine: "engine-20t",
      transmission: "trans-at",
      drive: "drive-awd",
    });
  });

  it("reads an unchosen level, absent or null, as the same unchosen level", () => {
    const bare = { make: { id: "m" }, model: { id: "x" }, year: null };
    const explicit = { ...bare, generation: null, body: null, engine: null };
    expect(sameCar(bare, explicit)).toBe(true);
  });

  it("compares ready identities level by level", () => {
    const a = carIdentity(sameCarCases()[0]!.a);
    expect(sameCarIdentity(a, { ...a })).toBe(true);
    expect(sameCarIdentity(a, { ...a, year: null })).toBe(false);
  });
});
