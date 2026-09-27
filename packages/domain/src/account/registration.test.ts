import { describe, expect, it } from "vitest";
import { isRegistrationComplete } from "./registration";

describe("isRegistrationComplete (TASK-029)", () => {
  it("is false for a freshly signed-in account (no name, no consent)", () => {
    expect(isRegistrationComplete({ name: null, consentPhoneShareAt: null })).toBe(false);
  });

  it("is false with a name but no consent", () => {
    expect(isRegistrationComplete({ name: "Марат", consentPhoneShareAt: null })).toBe(false);
  });

  it("is false with consent but no name", () => {
    expect(isRegistrationComplete({ name: null, consentPhoneShareAt: new Date() })).toBe(false);
  });

  it("is true once both are recorded", () => {
    expect(isRegistrationComplete({ name: "Марат", consentPhoneShareAt: new Date() })).toBe(true);
  });

  it("accepts the consent moment as an ISO string, the shape a JSON response carries", () => {
    expect(
      isRegistrationComplete({ name: "Марат", consentPhoneShareAt: "2026-09-27T10:00:00.000Z" }),
    ).toBe(true);
  });

  it("treats an empty name as no name", () => {
    expect(isRegistrationComplete({ name: "", consentPhoneShareAt: new Date() })).toBe(false);
  });
});
