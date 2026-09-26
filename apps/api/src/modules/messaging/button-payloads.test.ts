import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import { BUTTON_PAYLOAD_MAX_LENGTH, ButtonPayloads } from "./button-payloads";

const config = (secret: string) => ({ session: { tokenSecret: secret } }) as unknown as AppConfig;

const ORDER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const MEMBER = "9b2f8f7e-1d0c-4a6e-8a41-2f3b5c6d7e8f";
const NOW = new Date("2026-09-26T10:00:00Z");
const LATER = new Date("2026-09-29T10:00:00Z");

describe("signed payloads of quick replies (TASK-025)", () => {
  const payloads = new ButtonPayloads(config("a-test-session-secret-of-32-characters!"));

  it("reads back what it signed: the button, the fields and the expiry", () => {
    const payload = payloads.sign("confirm", [ORDER, MEMBER], LATER);
    expect(payload.startsWith(`confirm:${ORDER}:${MEMBER}:`)).toBe(true);
    expect(payload.length).toBeLessThanOrEqual(BUTTON_PAYLOAD_MAX_LENGTH);
    expect(payloads.read(payload, NOW)).toEqual({
      ok: true,
      button: "confirm",
      fields: [ORDER, MEMBER],
      expiresAt: LATER,
    });
  });

  it("refuses a payload changed in any part: the button, a field, the expiry, the signature", () => {
    const payload = payloads.sign("confirm", [ORDER, MEMBER], LATER);
    const parts = payload.split(":");
    const signature = parts[4]!;
    const otherLast = signature.endsWith("A") ? "B" : "A";
    const forged = [
      ["decline", ...parts.slice(1)].join(":"),
      [parts[0], MEMBER, ORDER, ...parts.slice(3)].join(":"),
      [parts[0], ORDER.replace("7c9e", "7c9f"), ...parts.slice(2)].join(":"),
      [...parts.slice(0, 3), String(Number(parts[3]) + 3600), parts[4]].join(":"),
      [...parts.slice(0, 4), `${signature.slice(0, -1)}${otherLast}`].join(":"),
      [...parts.slice(0, 4), ""].join(":"),
    ];
    for (const candidate of forged) {
      expect(payloads.read(candidate, NOW), candidate).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });

  it("refuses a payload signed with another secret", () => {
    const other = new ButtonPayloads(config("another-session-secret-of-32-characters!!"));
    const payload = other.sign("confirm", [ORDER, MEMBER], LATER);
    expect(payloads.read(payload, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reads an authentic payload past its time as expired, and a forged one as forged", () => {
    const payload = payloads.sign("decline", [ORDER, MEMBER], NOW);
    expect(payloads.read(payload, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(payloads.read(payload, LATER)).toEqual({ ok: false, reason: "expired" });
  });

  it("does not read what is not the shape of a payload at all", () => {
    for (const candidate of [
      "",
      "confirm",
      "confirm:order-1042:sig",
      "some unreadable payload",
      `confirm:${ORDER}:${MEMBER}:not-a-time:sig`,
      `Confirm:${ORDER}:1790000000:sig`,
      `confirm:${ORDER} ${MEMBER}:1790000000:sig`,
      "x".repeat(BUTTON_PAYLOAD_MAX_LENGTH + 1),
    ]) {
      const reading = payloads.read(candidate, NOW);
      expect(reading.ok, candidate).toBe(false);
      expect(["malformed", "bad_signature"]).toContain((reading as { reason: string }).reason);
    }
    expect(payloads.read("confirm:order-1042:sig", NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("will not sign a field that could be read back as two", () => {
    expect(() => payloads.sign("confirm", ["a:b"], LATER)).toThrow();
    expect(() => payloads.sign("Confirm", [ORDER], LATER)).toThrow();
  });
});
