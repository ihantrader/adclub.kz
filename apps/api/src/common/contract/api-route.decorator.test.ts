import { Injectable, type CanActivate } from "@nestjs/common";
import { apiRoutes } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  ApiRoute,
  RateLimitGuardMark,
  SessionAccessGuard,
  toNestPath,
} from "./api-route.decorator";

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
@SessionAccessGuard()
class MarkedGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
@RateLimitGuardMark()
class LimitGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

describe("ApiRoute", () => {
  it("refuses to bind a session route without the session access guard", () => {
    expect(() => ApiRoute(apiRoutes.getCurrentAccount)).toThrow(
      /getCurrentAccount requires a session/,
    );
    expect(() => ApiRoute(apiRoutes.getCurrentAccount, { guards: [] })).toThrow();
    // Some other guard is not enough: it wouldn't apply the access rule.
    expect(() => ApiRoute(apiRoutes.getCurrentAccount, { guards: [AllowGuard] })).toThrow(
      /session access guard/,
    );
    expect(() =>
      ApiRoute(apiRoutes.getCurrentAccount, { guards: [AllowGuard, MarkedGuard] }),
    ).not.toThrow();
  });

  it("refuses to bind a session route that declares no contexts", () => {
    const { contexts: _contexts, ...withoutContexts } = apiRoutes.getCurrentAccount;
    expect(() => ApiRoute(withoutContexts, { guards: [MarkedGuard] })).toThrow(
      /getCurrentAccount requires a session but declares no contexts/,
    );
    expect(() =>
      ApiRoute({ ...apiRoutes.getSupplierCompany, contexts: [] }, { guards: [MarkedGuard] }),
    ).toThrow(/declares no contexts/);
    expect(() => ApiRoute(apiRoutes.getSupplierCompany, { guards: [MarkedGuard] })).not.toThrow();
  });

  it("refuses to bind a rate limited route without the rate limit guard (TASK-016)", () => {
    expect(() => ApiRoute(apiRoutes.submitSupplierLead)).toThrow(
      /submitSupplierLead declares a rate limit/,
    );
    expect(() => ApiRoute(apiRoutes.checkCompatibility, { guards: [AllowGuard] })).toThrow(
      /rate limit guard/,
    );
    expect(() => ApiRoute(apiRoutes.submitSupplierLead, { guards: [LimitGuard] })).not.toThrow();
  });

  it("binds a public route without guards", () => {
    expect(() => ApiRoute(apiRoutes.getHealth)).not.toThrow();
  });

  it("turns contract path parameters into Nest ones", () => {
    expect(toNestPath("/auth/sessions/{sessionId}")).toBe("/auth/sessions/:sessionId");
    expect(toNestPath("/a/{x}/b/{y}")).toBe("/a/:x/b/:y");
    expect(toNestPath("/health")).toBe("/health");
  });
});
