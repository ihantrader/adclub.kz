import { describe, expect, it } from "vitest";
import {
  decideAccess,
  resolveAccessContext,
  type AccessContext,
  type AccessPrincipal,
} from "./access-predicate";

const active = { status: "active" } as const;
const removed = { status: "removed" } as const;

const mobile: AccessPrincipal = { kind: "mobile" };
const supplier: AccessPrincipal = { kind: "supplier_web", membership: active };
const admin: AccessPrincipal = {
  kind: "admin_web",
  admin: { status: "active", totpConfigured: true },
};

const routeGroups: Record<string, readonly AccessContext[]> = {
  user: ["user"],
  supplier: ["supplier"],
  admin: ["admin"],
  any: ["user", "supplier", "admin"],
  none: [],
};

describe("decideAccess", () => {
  // Session kind × route contexts: a session only ever gets its own context.
  it.each([
    [mobile, "user", true],
    [mobile, "supplier", false],
    [mobile, "admin", false],
    [mobile, "any", true],
    [mobile, "none", false],
    [supplier, "user", false],
    [supplier, "supplier", true],
    [supplier, "admin", false],
    [supplier, "any", true],
    [supplier, "none", false],
    [admin, "user", false],
    [admin, "supplier", false],
    [admin, "admin", true],
    [admin, "any", true],
    [admin, "none", false],
  ] as const)("%j on a %s route → allowed=%s", (principal, group, allowed) => {
    const decision = decideAccess(routeGroups[group]!, principal);
    expect(decision.allowed).toBe(allowed);
    if (!decision.allowed) {
      expect(decision).toMatchObject({ reason: "context_not_allowed" });
    }
  });

  it("takes the context of a removed employee away on every route", () => {
    for (const membership of [removed, null]) {
      for (const group of Object.values(routeGroups)) {
        expect(decideAccess(group, { kind: "supplier_web", membership })).toEqual({
          allowed: false,
          reason: "membership_removed",
        });
      }
    }
  });

  it("takes the context of a removed administrator or a reset second factor away", () => {
    expect(
      decideAccess(["admin"], {
        kind: "admin_web",
        admin: { status: "removed", totpConfigured: true },
      }),
    ).toEqual({ allowed: false, reason: "admin_removed" });
    expect(decideAccess(["admin"], { kind: "admin_web", admin: null })).toEqual({
      allowed: false,
      reason: "admin_removed",
    });
    expect(
      decideAccess(["user", "supplier", "admin"], {
        kind: "admin_web",
        admin: { status: "active", totpConfigured: false },
      }),
    ).toEqual({ allowed: false, reason: "totp_reset" });
  });

  it("names the context a session acts in", () => {
    expect(resolveAccessContext(mobile)).toEqual({ context: "user" });
    expect(resolveAccessContext(supplier)).toEqual({ context: "supplier" });
    expect(resolveAccessContext(admin)).toEqual({ context: "admin" });
  });
});
