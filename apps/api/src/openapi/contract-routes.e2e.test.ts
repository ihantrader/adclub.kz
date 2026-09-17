import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { apiRoutes, buildOpenApiDocument } from "@adclub/contracts";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { listServedRoutes } from "../common/contract";
import { checkServedRoutesMatchContract } from "./check-served-routes";
import { routeListingConfig } from "./route-listing-config";

// Dependencies point at closed local ports: the app boots without them
// (TASK-002), and none of these tests reach a handler that needs them.
async function boot(nodeEnv: "production" | "development"): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(routeListingConfig(nodeEnv)), {
    logger: false,
  });
  await app.init();
  return app;
}

const contract = Object.values(apiRoutes);

describe("served routes vs contract (full AppModule)", () => {
  let production: INestApplication;
  let development: INestApplication;

  beforeAll(async () => {
    [production, development] = await Promise.all([boot("production"), boot("development")]);
  });

  afterAll(async () => {
    await Promise.all([production?.close(), development?.close()]);
  });

  it("serves exactly the contract routes in production", () => {
    expect(checkServedRoutesMatchContract(listServedRoutes(production), contract)).toEqual([]);
    const paths = listServedRoutes(production).map((route) => route.path);
    expect(paths).not.toContain("/openapi.json");
    expect(paths).not.toContain("/dev/login-codes");
  });

  it("serves the contract routes plus the docs and the dev code outbox in development", () => {
    expect(checkServedRoutesMatchContract(listServedRoutes(development), contract)).toEqual([]);
    const paths = listServedRoutes(development).map((route) => route.path);
    expect(paths).toEqual(expect.arrayContaining(["/openapi.json", "/docs", "/dev/login-codes"]));
  });

  it("serves the generated OpenAPI document and the docs page in development", async () => {
    const document = await request(development.getHttpServer()).get("/openapi.json");
    expect(document.status).toBe(200);
    expect(document.body).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument(contract))));

    const docs = await request(development.getHttpServer()).get("/docs");
    expect(docs.status).toBe(200);
    expect(docs.headers["content-type"]).toContain("text/html");
    expect(docs.text).toContain("/openapi.json");
  });

  it("does not serve the docs or the dev code outbox in production", async () => {
    for (const path of ["/openapi.json", "/dev/login-codes"]) {
      const response = await request(production.getHttpServer()).get(path);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("NOT_FOUND");
    }
  });

  it("serves health and the client policy through the real module wiring", async () => {
    const health = await request(production.getHttpServer()).get("/health");
    expect(health.status).toBe(200);

    const policy = await request(production.getHttpServer())
      .get("/meta/client-policy")
      .set("Accept-Language", "en");
    expect(policy.status).toBe(200);
    expect(policy.body.platforms.ios.minSupportedVersion).toBe("0.0.0");
  });
});

describe("checkServedRoutesMatchContract", () => {
  const served = [
    { method: "GET", path: "/health" },
    { method: "GET", path: "/ready" },
    { method: "GET", path: "/meta/client-policy" },
    { method: "POST", path: "/auth/login-code" },
    { method: "POST", path: "/auth/login-code/verify" },
    { method: "GET", path: "/dev/login-codes" },
    { method: "GET", path: "/{*path}" },
    { method: "POST", path: "/{*path}" },
  ];

  it("accepts a server that serves exactly the contract", () => {
    expect(checkServedRoutesMatchContract(served, contract)).toEqual([]);
  });

  it("reports a served route missing from the contract", () => {
    expect(
      checkServedRoutesMatchContract([...served, { method: "POST", path: "/orders" }], contract),
    ).toEqual(["POST /orders is served but missing from apiRoutes (@adclub/contracts)"]);
  });

  it("reports a contract route the server doesn't serve", () => {
    expect(
      checkServedRoutesMatchContract(
        served.filter((route) => route.path !== "/ready"),
        contract,
      ),
    ).toEqual(["GET /ready is in apiRoutes (@adclub/contracts) but the server doesn't serve it"]);
  });

  it("matches OpenAPI path parameters against Express ones", () => {
    const route = { ...apiRoutes.getHealth, path: "/orders/{orderId}" };
    expect(
      checkServedRoutesMatchContract([{ method: "GET", path: "/orders/:orderId" }], [route]),
    ).toEqual([]);
  });
});
