import { describe, expect, it } from "vitest";
import {
  apiRoutes,
  buildRoutePath,
  isUploadRoute,
  MODEL_REQUEST_CLIENT_WAIT_MS,
  MODEL_REQUEST_SERVER_MAX_SECONDS,
  modelRoutes,
  waitsForModel,
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
    expect(uploadRoutePaths).toEqual([
      "/garage/dashboard",
      "/garage/vehicle-document",
      "/admin/catalog/items/{itemId}/photos",
      "/admin/vehicles/imports",
      "/supplier/price-imports",
      "/catalog/part-photo",
    ]);
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

describe("routes that wait for a model (TASK-063.B)", () => {
  it("are exactly the assistant's turn and the three photo recognitions", () => {
    expect(modelRoutes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "POST /assistant/messages",
      "POST /catalog/part-photo",
      "POST /garage/dashboard",
      "POST /garage/vehicle-document",
    ]);
    // None has path parameters: `waitsForModel` compares paths as they are.
    expect(modelRoutes.every((route) => route.pathParams === undefined)).toBe(true);
  });

  it("are recognized by method and URL, with or without origin and query", () => {
    expect(waitsForModel("POST", "http://10.0.0.5:3000/assistant/messages")).toBe(true);
    expect(waitsForModel("post", "/catalog/part-photo?deviceId=x&vehicleYear=2023")).toBe(true);
    expect(waitsForModel("POST", "https://api.example/garage/dashboard#x")).toBe(true);
    expect(waitsForModel("GET", "http://h/assistant/messages")).toBe(false);
    expect(waitsForModel("GET", "http://h/assistant/dialogs/abc")).toBe(false);
    expect(waitsForModel("POST", "http://h/assistant/messages/abc/complaint")).toBe(false);
    expect(waitsForModel("GET", "http://h/garage/vehicle-document/attempts")).toBe(false);
    expect(waitsForModel("POST", "http://h/orders")).toBe(false);
  });

  it("are waited for longer than the server may take on them", () => {
    expect(MODEL_REQUEST_CLIENT_WAIT_MS).toBeGreaterThanOrEqual(
      (MODEL_REQUEST_SERVER_MAX_SECONDS + 15) * 1000,
    );
  });
});
