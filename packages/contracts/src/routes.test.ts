import { describe, expect, it } from "vitest";
import { apiRoutes, buildRoutePath } from "./routes";

describe("buildRoutePath", () => {
  it("returns a path without placeholders as it is", () => {
    expect(buildRoutePath(apiRoutes.listSessions)).toBe("/auth/sessions");
  });

  it("substitutes and encodes path parameters", () => {
    expect(
      buildRoutePath(apiRoutes.endSession, { sessionId: "0b9b3f0e-7c1a-4b8e-9d42-1f0c2a3b4c5d" }),
    ).toBe("/auth/sessions/0b9b3f0e-7c1a-4b8e-9d42-1f0c2a3b4c5d");
    expect(buildRoutePath(apiRoutes.endSession, { sessionId: "../me?x=1" })).toBe(
      "/auth/sessions/..%2Fme%3Fx%3D1",
    );
  });

  it("refuses a missing parameter", () => {
    expect(() => buildRoutePath(apiRoutes.endSession, {})).toThrow(/sessionId/);
    expect(() => buildRoutePath(apiRoutes.endSession, { sessionId: "" })).toThrow(/sessionId/);
  });
});
