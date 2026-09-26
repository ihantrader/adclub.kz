import {
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiException } from "../../common/errors";
import { WHATSAPP_WEBHOOK_PATH } from "../../common/http";
import { APP_CONFIG, type AppConfig } from "../../config";
import { Metrics } from "../../observability";
import { RateLimitedNonContractRoute } from "../../rate-limit";
import { WebhookEvents } from "./webhook-events.service";
import {
  isValidWebhookSignature,
  verifySubscription,
  WEBHOOK_SIGNATURE_HEADER,
} from "./webhook-signature";

/**
 * Where the provider reports what became of our messages and what people
 * pressed (TASK-024 requirement 4; ARCHITECTURE 9.1, 4.35).
 *
 * Deliberately outside the client contract, like `/metrics`: no client of
 * ours calls it, and the subscription check answers the provider's
 * challenge as plain text, not JSON. What it does keep is every rule of an
 * open route — the limit is counted by the one guard
 * (`RateLimitedNonContractRoute`, so `TRUST_PROXY` decides the address as
 * everywhere else), and the body is read by the one middleware with a
 * ceiling on its size.
 *
 * **Nothing is applied without a checked signature.** The body is bytes at
 * this point and stays bytes until the signature matches; only then is the
 * delivery written down and the work queued, and the answer goes back at
 * once. A body with no signature or a foreign one gets 403 and leaves no
 * trace in the database.
 */
@Injectable()
@Controller()
export class WhatsappWebhookController {
  private readonly logger = new Logger("Messaging");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WebhookEvents) private readonly events: WebhookEvents,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  /**
   * The subscription check Meta makes once, when the callback address is
   * saved: the challenge comes back as it was, as plain text — a JSON
   * string with quotes around it would not be the challenge.
   */
  @Get(WHATSAPP_WEBHOOK_PATH)
  @RateLimitedNonContractRoute({ limit: "whatsapp_webhook_per_ip", whenUnavailable: "allow" })
  verify(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): string {
    const verifyToken = this.config.messaging.whatsapp.webhookVerifyToken;
    const result: ReturnType<typeof verifySubscription> = verifyToken
      ? verifySubscription(query, verifyToken)
      : { ok: false, reason: "no verify token is configured" };
    if (!result.ok) {
      this.metrics.countWebhookEvent("subscription_refused");
      // The token itself is never in the line.
      this.logger.warn(`Webhook subscription refused: ${result.reason}`);
      throw new ApiException(403, "FORBIDDEN", "The subscription could not be confirmed");
    }
    this.logger.log("Webhook subscription confirmed");
    // Plain text, set only now: a header set by a decorator would also label
    // the JSON of a refusal as text.
    response.type("text/plain; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    return result.challenge;
  }

  /**
   * One delivery of the provider. Always 200 once the signature is right,
   * whatever the body turns out to hold: the provider repeats a delivery it
   * did not get a 200 for, so an event of an unknown kind must not be a
   * refusal (requirement 4).
   */
  @Post(WHATSAPP_WEBHOOK_PATH)
  @HttpCode(200)
  @Header("cache-control", "no-store")
  @RateLimitedNonContractRoute({ limit: "whatsapp_webhook_per_ip", whenUnavailable: "allow" })
  async receive(@Req() request: Request): Promise<{ received: true }> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const signature = request.headers[WEBHOOK_SIGNATURE_HEADER];
    const appSecret = this.config.messaging.whatsapp.appSecret;
    // Without the app secret there is nothing to check a signature against,
    // and an event nobody can vouch for is never applied.
    if (
      !appSecret ||
      !isValidWebhookSignature(
        body,
        typeof signature === "string" ? signature : undefined,
        appSecret,
      )
    ) {
      this.metrics.countWebhookEvent("bad_signature");
      // Neither the body nor the signature is logged: the body is not even
      // parsed, and nothing about it is written anywhere.
      this.logger.warn(
        `Webhook refused: ${signature === undefined ? "no signature" : "the signature does not match"}`,
      );
      throw new ApiException(403, "FORBIDDEN", "The signature does not match");
    }
    if (body.length === 0) {
      // A signed empty body is nothing to apply, and a 200 stops the repeats.
      this.metrics.countWebhookEvent("empty");
      return { received: true };
    }
    // The parsing and the applying happen in the worker: a slow handler
    // here would make the provider repeat the delivery.
    await this.events.receive(body);
    return { received: true };
  }
}
