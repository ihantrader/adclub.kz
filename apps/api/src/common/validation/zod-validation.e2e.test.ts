import { Body, Controller, Module, Post, type INestApplication } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import request from "supertest";
import { APP_CONFIG } from "../../config";
import { HttpExceptionFilter } from "../errors/http-exception.filter";
import { NotFoundController } from "../errors/not-found.controller";
import { JsonLoggerService } from "../logging/json-logger.service";
import { ZodValidationPipe } from "./zod-validation.pipe";

const createOrderNoteSchema = z.object({ phone: z.string().min(1) });

/**
 * Minimal, test-only controller: TASK-002 ships no business endpoint that
 * takes a body yet (those arrive in TASK-003+), so the unified-error-format
 * requirement for "invalid body" (AC-5) is proven here, against the real
 * pipe + global filter wired exactly as `AppModule` wires them, over a
 * real HTTP request. `/health`, `/ready` and unknown routes are proven
 * against the actual running app in verification instead.
 */
@Controller("fixture")
class FixtureController {
  @Post()
  create(
    @Body(new ZodValidationPipe(createOrderNoteSchema)) body: z.infer<typeof createOrderNoteSchema>,
  ) {
    return { received: body.phone };
  }
}

@Module({
  controllers: [FixtureController, NotFoundController],
  providers: [
    JsonLoggerService,
    { provide: APP_CONFIG, useValue: { logLevel: "log" } },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class FixtureModule {}

describe("validation and error format, wired end to end", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(FixtureModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the parsed body for a valid request", async () => {
    const response = await request(app.getHttpServer())
      .post("/fixture")
      .send({ phone: "+77001234567" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ received: "+77001234567" });
  });

  it("returns a unified VALIDATION_ERROR response for an invalid body", async () => {
    const response = await request(app.getHttpServer()).post("/fixture").send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "VALIDATION_ERROR", retryable: false });
    expect(Array.isArray(response.body.details)).toBe(true);
    expect(response.body).not.toHaveProperty("stack");
  });

  it("returns a unified NOT_FOUND response for an unknown route", async () => {
    const response = await request(app.getHttpServer()).get("/this-route-does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });
});
