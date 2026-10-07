import { describe, expect, it } from "vitest";
import { supplierReachVerdict, type RecipientReach } from "./supplier-reach-verdict";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 10, minute));

const noWhatsapp = (memberId: string, minute: number): RecipientReach => ({
  memberId,
  last: { kind: "no_whatsapp", at: at(minute) },
});
const delivered = (memberId: string, minute: number): RecipientReach => ({
  memberId,
  last: { kind: "delivered", at: at(minute) },
});
const unknown = (memberId: string): RecipientReach => ({ memberId, last: null });

describe("supplierReachVerdict", () => {
  it("is unreachable when every recipient has no WhatsApp, with the first and the last refusal", () => {
    expect(supplierReachVerdict([noWhatsapp("a", 5), noWhatsapp("b", 2)])).toEqual({
      unreachable: true,
      withoutWhatsapp: 2,
      firstFailureAt: at(2),
      lastFailureAt: at(5),
      reachedAt: null,
    });
  });

  it("is reachable while one recipient still gets messages, and says when one last arrived", () => {
    const verdict = supplierReachVerdict([noWhatsapp("a", 5), delivered("b", 7)]);
    expect(verdict.unreachable).toBe(false);
    expect(verdict.withoutWhatsapp).toBe(1);
    expect(verdict.reachedAt).toEqual(at(7));
  });

  it("does not judge a recipient nobody has written to yet", () => {
    expect(supplierReachVerdict([noWhatsapp("a", 5), unknown("b")]).unreachable).toBe(false);
  });

  it("does not call a company without recipients unreachable", () => {
    expect(supplierReachVerdict([]).unreachable).toBe(false);
  });

  it("takes one recipient without WhatsApp as the whole company when they are the only one", () => {
    expect(supplierReachVerdict([noWhatsapp("a", 1)]).unreachable).toBe(true);
  });
});
