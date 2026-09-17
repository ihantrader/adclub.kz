import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiErrorResponseSchema, errorCodeSchema } from "./error";
import { healthCheckResponseSchema } from "./health";
import { buildOpenApiDocument } from "./openapi";
import { apiRoutes, type ApiRouteDefinition } from "./routes";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON traversal

const routes: ApiRouteDefinition[] = Object.values(apiRoutes);
const document = buildOpenApiDocument(routes) as Json;

describe("buildOpenApiDocument", () => {
  it("produces an OpenAPI 3.1 document with every contract route", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/auth/login-code",
      "/auth/login-code/verify",
      "/auth/logout",
      "/auth/me",
      "/auth/session/refresh",
      "/auth/sessions",
      "/auth/sessions/end-all",
      "/auth/sessions/end-others",
      "/auth/sessions/{sessionId}",
      "/health",
      "/meta/client-policy",
      "/ready",
    ]);
    expect(document.paths["/health"].get.operationId).toBe("getHealth");
    expect(document.paths["/ready"].get.responses["503"]).toBeDefined();
  });

  it("documents the unified error format on every operation", () => {
    for (const route of routes) {
      const operation = document.paths[route.path][route.method.toLowerCase()];
      expect(operation.responses.default).toEqual({ $ref: "#/components/responses/Error" });
    }
    const errorSchema = document.components.schemas.ApiErrorResponse;
    expect(errorSchema.required).toEqual(["code", "message", "retryable"]);
    expect(document.components.schemas.ErrorCode.enum).toEqual(errorCodeSchema.options);
    expect(document.components.schemas.ErrorCode.enum).toContain("CLIENT_UPDATE_REQUIRED");
  });

  it("documents 426 only on routes that enforce the client version", () => {
    expect(document.paths["/ready"].get.responses["426"]).toBeDefined();
    expect(document.paths["/health"].get.responses["426"]).toBeUndefined();
    expect(document.paths["/meta/client-policy"].get.responses["426"]).toBeUndefined();
  });

  it("derives component schemas from the zod schemas", () => {
    expect(Object.keys(document.components.schemas.HealthCheckResponse.properties)).toEqual(
      Object.keys(healthCheckResponseSchema.shape),
    );
    expect(Object.keys(document.components.schemas.ApiErrorResponse.properties)).toEqual(
      Object.keys(apiErrorResponseSchema.shape),
    );
    expect(document.components.schemas.ClientPolicyResponse.required).toEqual([
      "platforms",
      "message",
    ]);
  });

  it("leaves response objects open to additive fields", () => {
    expect(JSON.stringify(document)).not.toContain('"additionalProperties":false');
  });

  it("refuses a response schema that isn't a named component instead of inlining it", () => {
    const extendedHealth = healthCheckResponseSchema.extend({ version: z.string() });
    const changedRoute: ApiRouteDefinition = {
      ...apiRoutes.getHealth,
      responses: { 200: { description: "changed", schema: extendedHealth } },
    };
    expect(() => buildOpenApiDocument([changedRoute])).toThrow(/missing from componentSchemas/);
  });

  it("documents a required JSON request body only on routes that take one", () => {
    const requestCode = document.paths["/auth/login-code"].post;
    expect(requestCode.operationId).toBe("requestLoginCode");
    expect(requestCode.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/RequestLoginCodeBody" } },
      },
    });
    expect(document.paths["/auth/login-code/verify"].post.requestBody.content).toEqual({
      "application/json": { schema: { $ref: "#/components/schemas/VerifyLoginCodeBody" } },
    });
    expect(document.paths["/health"].get.requestBody).toBeUndefined();

    const body = document.components.schemas.RequestLoginCodeBody;
    expect(body.required).toEqual(["phone"]);
    expect(body.properties.phone.maxLength).toBe(32);
    expect(body.properties.channel).toEqual({ $ref: "#/components/schemas/LoginCodeChannel" });
  });

  it("documents the login code error codes and their details", () => {
    expect(document.components.schemas.ErrorCode.enum).toEqual(
      expect.arrayContaining([
        "LOGIN_CODE_INVALID",
        "LOGIN_CODE_EXPIRED",
        "LOGIN_CODE_DELIVERY_FAILED",
        "RATE_LIMITED",
        "SERVICE_UNAVAILABLE",
      ]),
    );
    expect(document.components.schemas.RateLimitedDetails.required).toEqual([
      "limit",
      "retryAfterSeconds",
    ]);
    expect(document.components.schemas.LoginCodeInvalidDetails.required).toEqual([
      "attemptsRemaining",
    ]);
  });

  it("refuses a request body schema that isn't a named component", () => {
    const changedRoute: ApiRouteDefinition = {
      ...apiRoutes.requestLoginCode,
      requestBody: { description: "changed", schema: z.object({ phone: z.string() }) },
    };
    expect(() => buildOpenApiDocument([changedRoute])).toThrow(
      /Request body of requestLoginCode uses a schema missing from componentSchemas/,
    );
  });

  it("marks session routes with the bearer security scheme, and only them", () => {
    expect(document.components.securitySchemes.sessionAccessToken).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    for (const route of routes) {
      const operation = document.paths[route.path][route.method.toLowerCase()];
      if (route.auth === "session") {
        expect(operation.security).toEqual([{ sessionAccessToken: [] }]);
      } else {
        expect(operation.security).toBeUndefined();
      }
    }
    expect(document.paths["/auth/me"].get.security).toBeDefined();
    expect(document.paths["/auth/session/refresh"].post.security).toBeUndefined();
    expect(document.paths["/auth/login-code/verify"].post.security).toBeUndefined();
  });

  it("documents path parameters from the route's pathParams", () => {
    const endSession = document.paths["/auth/sessions/{sessionId}"].delete;
    expect(endSession.parameters[0]).toEqual({
      name: "sessionId",
      in: "path",
      required: true,
      schema: expect.objectContaining({ type: "string", format: "uuid" }),
    });
    expect(document.paths["/auth/me"].get.parameters).toHaveLength(2);
  });

  it("refuses a route whose placeholders don't match its pathParams", () => {
    const changedRoute: ApiRouteDefinition = {
      ...apiRoutes.endSession,
      path: "/auth/sessions/{id}",
    };
    expect(() => buildOpenApiDocument([changedRoute])).toThrow(
      /path placeholders \(id\) must match pathParams \(sessionId\)/,
    );
    const missingParams: ApiRouteDefinition = { ...apiRoutes.getHealth, path: "/health/{x}" };
    expect(() => buildOpenApiDocument([missingParams])).toThrow(/must match pathParams \(none\)/);
  });

  it("adds the session fields to the verification response and documents the session codes", () => {
    const verified = document.components.schemas.LoginCodeVerifiedResponse;
    expect(verified.required).toEqual(["status", "phone", "accountId", "session"]);
    expect(verified.properties.session).toEqual({ $ref: "#/components/schemas/SessionTokens" });
    const tokens = document.components.schemas.SessionTokens;
    expect(tokens.required).not.toContain("refreshToken");
    expect(document.components.schemas.VerifyLoginCodeBody.required).toEqual(["phone", "code"]);
    expect(document.components.schemas.ErrorCode.enum).toEqual(
      expect.arrayContaining([
        "ACCESS_TOKEN_EXPIRED",
        "AUTH_REQUIRED",
        "SESSION_ENDED",
        "SESSION_KIND_UNAVAILABLE",
        "ORIGIN_NOT_ALLOWED",
      ]),
    );
  });

  it("carries no token examples", () => {
    const text = JSON.stringify(document);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(
      document.components.schemas.SessionTokens.properties.accessToken.examples,
    ).toBeUndefined();
    expect(
      document.components.schemas.SessionTokens.properties.refreshToken.examples,
    ).toBeUndefined();
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildOpenApiDocument([...routes].reverse()))).toBe(
      JSON.stringify(document),
    );
  });
});
