import { describe, expect, it } from "vitest";
import { orderGate, resumeOrderGate } from "./order-gate";

// Plain Node checks of where «Оформить» leads (TASK-030 requirements 1, 2; AC-1).

const member = { signedIn: true, clubAccess: true };

describe("«Оформить»", () => {
  it("asks a guest to sign in, whatever the card says", () => {
    expect(orderGate({ session: "guest", registrationCompleted: null, viewer: null })).toBe(
      "sign-in",
    );
    expect(orderGate({ session: "guest", registrationCompleted: null, viewer: member })).toBe(
      "sign-in",
    );
  });

  it("sends an account without a name to the registration before anything about club access", () => {
    expect(
      orderGate({
        session: "signed_in",
        registrationCompleted: false,
        viewer: { signedIn: true, clubAccess: false },
      }),
    ).toBe("register");
  });

  it("shows the stand-in to a member without club access — as the server said", () => {
    expect(
      orderGate({
        session: "signed_in",
        registrationCompleted: true,
        viewer: { signedIn: true, clubAccess: false },
      }),
    ).toBe("club-access");
  });

  it("checks out a member with club access", () => {
    expect(orderGate({ session: "signed_in", registrationCompleted: true, viewer: member })).toBe(
      "checkout",
    );
  });

  it("waits for the profile, and for the card as this account sees it (not the guest's card)", () => {
    expect(orderGate({ session: "signed_in", registrationCompleted: null, viewer: member })).toBe(
      "wait",
    );
    expect(orderGate({ session: "signed_in", registrationCompleted: true, viewer: null })).toBe(
      "wait",
    );
    expect(
      orderGate({
        session: "signed_in",
        registrationCompleted: true,
        viewer: { signedIn: false, clubAccess: false },
      }),
    ).toBe("wait");
  });
});

describe("the press remembered across the sign-in", () => {
  it("goes on to the checkout or the stand-in, waits, or is forgotten", () => {
    expect(resumeOrderGate("checkout")).toBe("go");
    expect(resumeOrderGate("club-access")).toBe("go");
    expect(resumeOrderGate("wait")).toBe("wait");
    // Back still a guest, or the registration left unfinished: the person decides again.
    expect(resumeOrderGate("sign-in")).toBe("forget");
    expect(resumeOrderGate("register")).toBe("forget");
  });
});
