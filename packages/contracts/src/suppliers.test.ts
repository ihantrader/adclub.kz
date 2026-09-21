import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { apiRoutes } from "./routes";
import {
  setSupplierScheduleBodySchema,
  submitSupplierLeadBodySchema,
  weeklyHoursSchema,
  type WeeklyHours,
} from "./suppliers";

function week(intervals: { from: string; to: string }[][]): WeeklyHours {
  return intervals.map((day, index) => ({ day: index + 1, intervals: day }));
}

const nineToSix = [{ from: "09:00", to: "18:00" }];

describe("the hours of a pickup point", () => {
  it("takes a working week with a lunch break, a day off and a day around the clock", () => {
    const hours = week([
      [
        { from: "09:00", to: "13:00" },
        { from: "14:00", to: "18:00" },
      ],
      nineToSix,
      nineToSix,
      nineToSix,
      nineToSix,
      [{ from: "00:00", to: "24:00" }],
      [],
    ]);
    expect(weeklyHoursSchema.safeParse(hours).success).toBe(true);
  });

  it("refuses a week that isn't the seven days in order", () => {
    expect(weeklyHoursSchema.safeParse(week([nineToSix])).success).toBe(false);
    const shuffled = week(Array.from({ length: 7 }, () => nineToSix));
    shuffled[0]!.day = 2;
    expect(weeklyHoursSchema.safeParse(shuffled).success).toBe(false);
  });

  it("refuses overlapping, reversed and midnight-crossing intervals", () => {
    const days = (day: { from: string; to: string }[]) => week([day, [], [], [], [], [], []]);
    expect(
      weeklyHoursSchema.safeParse(
        days([
          { from: "09:00", to: "14:00" },
          { from: "13:00", to: "18:00" },
        ]),
      ).success,
    ).toBe(false);
    expect(weeklyHoursSchema.safeParse(days([{ from: "18:00", to: "09:00" }])).success).toBe(false);
    expect(weeklyHoursSchema.safeParse(days([{ from: "22:00", to: "02:00" }])).success).toBe(false);
    expect(weeklyHoursSchema.safeParse(days([{ from: "24:00", to: "24:00" }])).success).toBe(false);
    expect(weeklyHoursSchema.safeParse(days([{ from: "9:00", to: "18:00" }])).success).toBe(false);
    expect(
      weeklyHoursSchema.safeParse(
        days([
          { from: "08:00", to: "10:00" },
          { from: "11:00", to: "12:00" },
          { from: "13:00", to: "14:00" },
          { from: "15:00", to: "16:00" },
        ]),
      ).success,
    ).toBe(false);
  });

  it("names the day and the interval at fault", () => {
    const result = setSupplierScheduleBodySchema.safeParse({
      expectedVersion: 1,
      weeklyHours: week([[], [{ from: "18:00", to: "09:00" }], [], [], [], [], []]),
      closedDates: [],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["weeklyHours", 1, "intervals", 0]);
  });
});

describe("the public connection request form", () => {
  const form = {
    companyName: "Автомаркет",
    bin: "080740000128",
    cityId: "0b2a6f6e-4a8a-4c42-9f59-5d7c1f0e2a11",
    type: "both",
    contactName: "Айгерим",
    phone: "+7 701 123 45 67",
    consent: true,
  };

  it("needs consent", () => {
    expect(submitSupplierLeadBodySchema.safeParse(form).success).toBe(true);
    expect(submitSupplierLeadBodySchema.safeParse({ ...form, consent: false }).success).toBe(false);
    const { consent: _consent, ...without } = form;
    expect(submitSupplierLeadBodySchema.safeParse(without).success).toBe(false);
  });

  it("bounds the length of every field", () => {
    expect(
      submitSupplierLeadBodySchema.safeParse({ ...form, companyName: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      submitSupplierLeadBodySchema.safeParse({ ...form, contactName: "x".repeat(101) }).success,
    ).toBe(false);
    expect(submitSupplierLeadBodySchema.safeParse({ ...form, phone: "7".repeat(33) }).success).toBe(
      false,
    );
    expect(
      submitSupplierLeadBodySchema.safeParse({ ...form, website: "x".repeat(501) }).success,
    ).toBe(false);
  });
});

describe("rate limits of open routes in the document", () => {
  it("documents the limit and what happens when it can't be counted", () => {
    const document = buildOpenApiDocument(Object.values(apiRoutes)) as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths["/supplier-leads"]!.post!["x-rate-limit"]).toEqual({
      limit: "supplier_lead_per_ip",
      whenUnavailable: "refuse",
    });
    expect(document.paths["/catalog/compatibility/check"]!.post!["x-rate-limit"]).toEqual({
      limit: "compatibility_check_per_ip",
      whenUnavailable: "allow",
    });
    expect(document.paths["/cities"]!.get!["x-rate-limit"]).toBeUndefined();
  });
});
