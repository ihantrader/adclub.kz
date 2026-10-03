/**
 * Where «Оформить» leads (SCREENS M-CAT-07, M-AUTH-00, 2.5; TASK-030
 * requirements 1, 2): a guest signs in, an account without a name finishes
 * the registration, a member without club access sees the stand-in for the
 * subscription, everybody else checks out. Club access is never worked out
 * here — it is what the server said in `viewer` of the card (D-059).
 */
export type OrderGate =
  /** M-AUTH-00 with T-GATE-01. */
  | "sign-in"
  /** M-AUTH-03. */
  | "register"
  /** The stand-in sheet until EPIC-14 (requirement 2). */
  | "club-access"
  /** M-ORD-01. */
  | "checkout"
  /** Something is still on its way: the profile, or the card as this account sees it. */
  | "wait";

export interface OrderGateInput {
  session: "guest" | "signed_in";
  /** `null` — the profile of the signed-in account has not loaded yet. */
  registrationCompleted: boolean | null;
  /** `viewer` of the card the button is on (`null` — not loaded). */
  viewer: { signedIn: boolean; clubAccess: boolean } | null;
}

export function orderGate({ session, registrationCompleted, viewer }: OrderGateInput): OrderGate {
  if (session === "guest") return "sign-in";
  if (registrationCompleted === null) return "wait";
  if (!registrationCompleted) return "register";
  // The card was loaded before signing in: it speaks for a guest, not for
  // this account — the card loads again, and the gate waits for it.
  if (!viewer || !viewer.signedIn) return "wait";
  return viewer.clubAccess ? "checkout" : "club-access";
}

/**
 * «Оформить» pressed by a guest is remembered and carried out when the
 * person comes back signed in (SCREENS M-AUTH-00: «после входа — возврат к
 * действию»). Back on the card, the remembered press either goes on — to the
 * checkout or the stand-in — waits for the card or the profile, or is
 * forgotten: the person came back still a guest, or left the registration
 * unfinished, and pressing again is theirs to decide.
 */
export function resumeOrderGate(gate: OrderGate): "go" | "wait" | "forget" {
  if (gate === "checkout" || gate === "club-access") return "go";
  if (gate === "wait") return "wait";
  return "forget";
}
