import { apiRoutes, isUploadRoute, type ApiRouteDefinition } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { WHATSAPP_WEBHOOK_BODY, WHATSAPP_WEBHOOK_PATH } from "./raw-body-routes";
import { contractPathOf, uploadRouteFor } from "./upload-routes";

/**
 * Which requests get their body read as bytes and let through the "every
 * body is JSON" check (TASK-013, TASK-024): the contract's upload routes and
 * the provider's webhook, and nothing else.
 */
describe("uploadRouteFor", () => {
  it("finds the webhook by its own declaration, with the declared ceiling", () => {
    const route = uploadRouteFor("POST", WHATSAPP_WEBHOOK_PATH);
    expect(route?.upload).toBe(WHATSAPP_WEBHOOK_BODY);
    // A bounded body: an event is a few kilobytes, never megabytes.
    expect(WHATSAPP_WEBHOOK_BODY.maxBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(WHATSAPP_WEBHOOK_BODY.contentTypes).toEqual(["application/json"]);
  });

  it("does not take the subscription check (a GET has no body) or another method", () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      expect(uploadRouteFor(method, WHATSAPP_WEBHOOK_PATH), method).toBeNull();
    }
  });

  it("does not take a path that only resembles the webhook's", () => {
    for (const path of [
      `${WHATSAPP_WEBHOOK_PATH}/extra`,
      "/webhooks",
      "/webhooks/whatsapp2",
      `/x${WHATSAPP_WEBHOOK_PATH}`,
    ]) {
      expect(uploadRouteFor("POST", path), path).toBeNull();
    }
  });

  it("tolerates a trailing slash and the case of the method, as for every upload route", () => {
    expect(uploadRouteFor("post", `${WHATSAPP_WEBHOOK_PATH}/`)).not.toBeNull();
  });

  it("still finds every upload route of the contract, and only those", () => {
    const uploads = (Object.values(apiRoutes) as ApiRouteDefinition[]).filter((candidate) =>
      isUploadRoute(candidate),
    );
    expect(uploads.length).toBeGreaterThan(0);
    for (const route of uploads) {
      const concrete = route.path.replace(/\{[^}]+\}/g, "00000000-0000-0000-0000-000000000000");
      expect(uploadRouteFor(route.method, concrete)?.upload, route.operationId).toBe(route.upload);
    }
    // A JSON route of the contract is not an upload.
    expect(uploadRouteFor("POST", "/auth/login-code")).toBeNull();
  });

  it("finds the webhook under every spelling Express would route to it", () => {
    // Express routes case-insensitively and by the path of an absolute-form
    // request target: a body read differently on those paths would reach the
    // handler already parsed, and the signature over its bytes could not hold.
    for (const path of [
      "/Webhooks/WhatsApp",
      "/WEBHOOKS/WHATSAPP/",
      "http://api.adclub.kz/webhooks/whatsapp",
      "https://api.adclub.kz:8443/Webhooks/whatsapp?x=1",
    ]) {
      expect(uploadRouteFor("POST", contractPathOf({ url: path })), path).not.toBeNull();
    }
  });

  it("does not take a path that only ends like the webhook's, in any spelling", () => {
    for (const path of [
      "http://api.adclub.kz/x/webhooks/whatsapp",
      "/webhooks/whatsapp/extra",
      "http://webhooks/whatsapp",
    ]) {
      expect(uploadRouteFor("POST", contractPathOf({ url: path })), path).toBeNull();
    }
  });

  it("reads the path of an absolute-form request target without its host, port or query", () => {
    expect(contractPathOf({ url: "http://host:3000/webhooks/whatsapp?a=1" })).toBe(
      "/webhooks/whatsapp",
    );
    expect(contractPathOf({ url: "http://host" })).toBe("/");
    expect(contractPathOf({ url: "http://host?a=1" })).toBe("/");
    expect(contractPathOf({ url: "/plain?a=1#x" })).toBe("/plain");
  });

  it("reads the path of a request without its query string", () => {
    expect(contractPathOf({ url: `${WHATSAPP_WEBHOOK_PATH}?hub.mode=subscribe` })).toBe(
      WHATSAPP_WEBHOOK_PATH,
    );
    expect(contractPathOf({ originalUrl: `${WHATSAPP_WEBHOOK_PATH}?a=1#x`, url: "/ignored" })).toBe(
      WHATSAPP_WEBHOOK_PATH,
    );
  });
});
