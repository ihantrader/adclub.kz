import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import {
  apiRoutes,
  storeSyncBodySchema,
  type MySubscriptionResponse,
  type StoreSyncBody,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ApiException } from "../../../common/errors";
import { APPLE_STORE_WEBHOOK_PATH, GOOGLE_STORE_WEBHOOK_PATH } from "../../../common/http";
import { ZodValidationPipe } from "../../../common/validation";
import { Metrics } from "../../../observability";
import { RateLimitedNonContractRoute, RateLimitedRoute } from "../../../rate-limit";
import { CurrentSession, type AuthenticatedSession } from "../../identity";
import { SubscriptionViews } from "../subscription-views";
import { StoreSubscriptions } from "./store-subscriptions";
import { StorePurchaseRefusedError, StoreUnavailableError } from "./store-word";

/** `POST /billing/store/sync` (context `user`): a purchase checked with its store (TASK-041). */
@Controller()
export class StoreSyncController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(StoreSubscriptions) private readonly stores: StoreSubscriptions,
    @Inject(SubscriptionViews) private readonly views: SubscriptionViews,
  ) {}

  @RateLimitedRoute(apiRoutes.syncStoreSubscription)
  @HttpCode(200)
  async sync(
    @Body(new ZodValidationPipe(storeSyncBodySchema)) body: StoreSyncBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<MySubscriptionResponse> {
    await this.stores.sync(session.accountId, body);
    return this.views.mine(session.accountId, pickLanguage(acceptLanguage));
  }
}

function bodyOf(request: Request): Buffer {
  return Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
}

/**
 * Where App Store and Google Play report a subscription (TASK-041;
 * ARCHITECTURE 9.4.1, 4.98). Outside the client contract, with the
 * discipline of the other webhooks: **the store's signature is checked
 * first** — Apple's JWS up to Apple's root before any field of it is
 * believed, Google's OIDC token before the body is read; a delivery that
 * fails it (or names another app, another environment) is a 403 and leaves
 * nothing behind. A delivery that passes is kept and answered 200 at once —
 * the worker applies it. A store not configured here answers 503, so the
 * store repeats it later. Neither the body nor the token is ever logged.
 */
@Controller()
export class StoreWebhookController {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(StoreSubscriptions) private readonly stores: StoreSubscriptions,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  private refuse(store: string, error: unknown): never {
    if (error instanceof StorePurchaseRefusedError) {
      this.metrics.countWebhookEvent("bad_signature");
      this.logger.warn(`${store} notification refused reason=${error.reason}`);
      throw new ApiException(403, "FORBIDDEN", "The notification is not ours");
    }
    if (error instanceof StoreUnavailableError) {
      throw new ApiException(503, "SERVICE_UNAVAILABLE", "Not available here", { retryable: true });
    }
    throw error;
  }

  @Post(APPLE_STORE_WEBHOOK_PATH)
  @HttpCode(200)
  @Header("cache-control", "no-store")
  @RateLimitedNonContractRoute({ limit: "store_webhook_per_ip", whenUnavailable: "allow" })
  async apple(@Req() request: Request): Promise<{ received: true }> {
    if (!this.stores.apple.canReceive) {
      this.refuse("App Store", new StoreUnavailableError("not configured", "not_configured"));
    }
    try {
      await this.stores.receiveApple(bodyOf(request));
    } catch (error) {
      this.refuse("App Store", error);
    }
    return { received: true };
  }

  @Post(GOOGLE_STORE_WEBHOOK_PATH)
  @HttpCode(200)
  @Header("cache-control", "no-store")
  @RateLimitedNonContractRoute({ limit: "store_webhook_per_ip", whenUnavailable: "allow" })
  async google(@Req() request: Request): Promise<{ received: true }> {
    try {
      await this.stores.google.verifyPush(request.headers.authorization);
    } catch (error) {
      this.refuse("Google Play", error);
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyOf(request).toString("utf8"));
    } catch {
      // Ours (the token is right) but unreadable: answered 200, so Pub/Sub
      // does not repeat what can't be mended.
      this.logger.warn("Google Play notification unreadable");
      return { received: true };
    }
    try {
      await this.stores.receiveGoogle(body);
    } catch (error) {
      if (error instanceof StorePurchaseRefusedError && error.reason === "malformed") {
        this.logger.warn("Google Play notification is not a developer notification");
        return { received: true };
      }
      this.refuse("Google Play", error);
    }
    return { received: true };
  }
}
