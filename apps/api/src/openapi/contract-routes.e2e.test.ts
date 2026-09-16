import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { apiRoutes, buildOpenApiDocument } from "@adclub/contracts";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { listServedRoutes } from "../common/contract";
import { loadConfig, type NodeEnv } from "../config";
import { checkServedRoutesMatchContract } from "./check-served-routes";

function configFor(nodeEnv: NodeEnv) {
  // Dependencies point at closed local ports: the app boots without them
  // (TASK-002), and none of these tests reach a handler that needs them.
  return loadConfig({
    NODE_ENV: nodeEnv,
    DATABASE_URL: "postgres://x:x@127.0.0.1:1/x",
    REDIS_URL: "redis://127.0.0.1:2",
    S3_ENDPOINT: "http://127.0.0.1:3",
    S3_ACCESS_KEY: "x",
    S3_SECRET_KEY: "x",
    S3_BUCKET: "x",
  });
}

async function boot(nodeEnv: NodeEnv): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(configFor(nodeEnv)), { logger: false });
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
  });

  it("serves the contract routes plus the docs in development", () => {
    expect(checkServedRoutesMatchContract(listServedRoutes(development), contract)).toEqual([]);
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

  it("does not serve the docs in production", async () => {
    const response = await request(production.getHttpServer()).get("/openapi.json");
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("NOT_FOUND");
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
