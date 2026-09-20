import { describe, expect, it } from "vitest";
import {
  apiRoutes,
  buildRoutePath,
  isUploadRoute,
  uploadRoutePaths,
  type ApiRouteDefinition,
} from "./routes";

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

describe("upload routes", () => {
  it("names every route whose body is a file, and only those", () => {
    expect(uploadRoutePaths).toEqual(["/admin/catalog/items/{itemId}/photos"]);
    expect(isUploadRoute(apiRoutes.uploadItemPhoto)).toBe(true);
    expect(isUploadRoute(apiRoutes.createCatalogItem)).toBe(false);
  });

  it("declares the media types and the ceiling of the body it reads", () => {
    expect(apiRoutes.uploadItemPhoto.upload).toMatchObject({
      contentTypes: ["image/jpeg", "image/png", "image/webp"],
      maxBytes: 50 * 1024 * 1024,
    });
    // A file route never declares a JSON body as well.
    const upload: ApiRouteDefinition = apiRoutes.uploadItemPhoto;
    expect(upload.requestBody).toBeUndefined();
  });
});
