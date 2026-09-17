import {
  Controller,
  Get,
  Module,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import { apiErrorResponseSchema, clientPolicyResponseSchema } from "@adclub/contracts";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpExceptionFilter, NotFoundModule } from "../common/errors";
import { AccessLogMiddleware, JsonLoggerService, RequestIdMiddleware } from "../common/logging";
import { ApiRoute } from "../common/contract";
import { APP_CONFIG } from "../config";
import { HealthController } from "../health/health.controller";
import { settingDefinitions } from "../modules/settings";
import { ClientPolicyController } from "./client-policy.controller";
import { ClientPolicyService } from "./client-policy.service";
import { ClientPolicySource, type ClientPolicySettings } from "./client-policy.source";
import { ClientVersionGuard } from "./client-version.guard";

const defaultClientUpdateMessages = settingDefinitions.client_update_message.default;

/** Lets a test raise the minimum while the server is running. */
class MutableClientPolicySource extends ClientPolicySource {
  settings: ClientPolicySettings = initialSettings();

  getSettings(): Promise<ClientPolicySettings> {
    return Promise.resolve(this.settings);
  }
}

function initialSettings(): ClientPolicySettings {
  return {
    minSupportedVersions: {
      ios: "1.2.0",
      android: "2.0.0",
      "supplier-web": "0.0.0",
      "admin-web": "0.5.0",
    },
    updateMessage: { ...defaultClientUpdateMessages, ru: "Обновите приложение" },
  };
}

/** Stands in for any ordinary (version-enforced) route without dependencies. */
@Controller()
class OrdinaryController {
  @Get("ordinary")
  get() {
    return { ok: true };
  }

  // A route an outdated admin panel still reaches (sign-in, settings).
  @ApiRoute({
    operationId: "recoveryFixture",
    method: "GET",
    path: "/recovery",
    summary: "fixture",
    tag: "meta",
    clientVersionCheck: "enforced_except_admin_web",
    responses: {},
  })
  recovery() {
    return { ok: true };
  }
}

const source = new MutableClientPolicySource();

@Module({
  imports: [NotFoundModule],
  controllers: [HealthController, ClientPolicyController, OrdinaryController],
  providers: [
    { provide: APP_CONFIG, useValue: { logLevel: "log" } },
    JsonLoggerService,
    { provide: ClientPolicySource, useValue: source },
    ClientPolicyService,
    { provide: APP_GUARD, useClass: ClientVersionGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class ClientPolicyFixtureModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, AccessLogMiddleware).forRoutes("*");
  }
}

describe("client policy and version guard over HTTP", () => {
  let app: INestApplication;
  let logs: string[];

  beforeAll(async () => {
    app = await NestFactory.create(ClientPolicyFixtureModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    source.settings = initialSettings();
    logs = [];
    const capture = (chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  describe("GET /meta/client-policy", () => {
    it("returns the minimum version per platform and the Russian message by default", async () => {
      const response = await get("/meta/client-policy");

      expect(response.status).toBe(200);
      expect(clientPolicyResponseSchema.parse(response.body)).toEqual({
        platforms: {
          ios: { minSupportedVersion: "1.2.0" },
          android: { minSupportedVersion: "2.0.0" },
          "supplier-web": { minSupportedVersion: "0.0.0" },
          "admin-web": { minSupportedVersion: "0.5.0" },
        },
        message: "Обновите приложение",
      });
    });

    it("localizes the message by Accept-Language", async () => {
      const response = await get("/meta/client-policy").set("Accept-Language", "kk-KZ,ru;q=0.5");
      expect(response.body.message).toBe(defaultClientUpdateMessages.kk);
    });

    it("stays available to an outdated client", async () => {
      const response = await get("/meta/client-policy").set("X-Client", "mobile/1.0.0 (ios)");
      expect(response.status).toBe(200);
    });
  });

  describe("minimum version enforcement", () => {
    it("rejects an outdated client on an ordinary route with the unified error", async () => {
      const response = await get("/ordinary")
        .set("X-Client", "mobile/1.1.9 (ios)")
        .set("Accept-Language", "en");

      expect(response.status).toBe(426);
      expect(apiErrorResponseSchema.parse(response.body)).toEqual({
        code: "CLIENT_UPDATE_REQUIRED",
        message: defaultClientUpdateMessages.en,
        details: { platform: "ios", clientVersion: "1.1.9", minSupportedVersion: "1.2.0" },
        retryable: false,
      });
    });

    it("rejects an outdated client on an unknown route too", async () => {
      const response = await get("/does-not-exist").set("X-Client", "admin-web/0.4.9");
      expect(response.status).toBe(426);
      expect(response.body.code).toBe("CLIENT_UPDATE_REQUIRED");
    });

    it("keeps health available to an outdated client", async () => {
      const response = await get("/health").set("X-Client", "mobile/0.0.1 (android)");
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
    });

    it("serves a client at or above the minimum", async () => {
      expect((await get("/ordinary").set("X-Client", "mobile/1.2.0 (ios)")).status).toBe(200);
      expect((await get("/ordinary").set("X-Client", "admin-web/1.0.0")).status).toBe(200);
    });

    it("applies each platform's own minimum (iOS and Android differ)", async () => {
      expect((await get("/ordinary").set("X-Client", "mobile/1.5.0 (ios)")).status).toBe(200);
      expect((await get("/ordinary").set("X-Client", "mobile/1.5.0 (android)")).status).toBe(426);
    });

    it("serves a request without X-Client and logs the client as missing", async () => {
      const response = await get("/ordinary");

      expect(response.status).toBe(200);
      expect(logs.join("")).toContain("GET /ordinary 200");
      expect(logs.join("")).toContain("client=missing");
    });

    it.each(["garbage", "mobile/1.0 (ios)", "mobile/abc (android)", "admin-web/0.1.0 (ios)"])(
      "serves a malformed X-Client %j as an unknown client and logs it",
      async (header) => {
        const response = await get("/ordinary").set("X-Client", header);

        expect(response.status).toBe(200);
        const output = logs.join("");
        expect(output).toContain("Unrecognized X-Client header");
        expect(output).toContain("client=invalid");
        expect(output).not.toContain(header);
      },
    );

    it("picks up a raised minimum on the very next request", async () => {
      expect((await get("/ordinary").set("X-Client", "admin-web/0.5.0")).status).toBe(200);

      source.settings = {
        ...source.settings,
        minSupportedVersions: { ...source.settings.minSupportedVersions, "admin-web": "0.6.0" },
      };

      const response = await get("/ordinary").set("X-Client", "admin-web/0.5.0");
      expect(response.status).toBe(426);
      expect(response.body.details.minSupportedVersion).toBe("0.6.0");
    });

    it("still serves an outdated admin panel on the routes that let it fix the policy", async () => {
      expect((await get("/ordinary").set("X-Client", "admin-web/0.4.0")).status).toBe(426);
      expect((await get("/recovery").set("X-Client", "admin-web/0.4.0")).status).toBe(200);
      // Only the admin panel: other outdated clients get 426 there too.
      const mobile = await get("/recovery").set("X-Client", "mobile/1.0.0 (ios)");
      expect(mobile.status).toBe(426);
      expect(mobile.body.code).toBe("CLIENT_UPDATE_REQUIRED");
    });

    it("writes the rejected request to the access log with its client", async () => {
      await get("/ordinary").set("X-Client", "mobile/1.0.0 (ios)");

      const accessLine = logs.find((line) => line.includes("GET /ordinary"));
      expect(accessLine).toBeDefined();
      expect(accessLine).toContain("426");
      expect(accessLine).toContain("client=mobile/1.0.0 (ios)");
      expect(JSON.parse(accessLine!).requestId).toEqual(expect.any(String));
    });
  });
});
