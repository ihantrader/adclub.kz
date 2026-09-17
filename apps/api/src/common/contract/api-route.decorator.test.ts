import { Injectable, type CanActivate } from "@nestjs/common";
import { apiRoutes } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { ApiRoute, toNestPath } from "./api-route.decorator";

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

describe("ApiRoute", () => {
  it("refuses to bind a session route without a guard", () => {
    expect(() => ApiRoute(apiRoutes.getCurrentAccount)).toThrow(
      /getCurrentAccount requires a session/,
    );
    expect(() => ApiRoute(apiRoutes.getCurrentAccount, { guards: [] })).toThrow();
    expect(() => ApiRoute(apiRoutes.getCurrentAccount, { guards: [AllowGuard] })).not.toThrow();
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
