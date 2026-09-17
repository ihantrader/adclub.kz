import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  LoginCodeChannel,
  LoginCodeInvalidDetails,
  LoginCodeSentResponse,
  RateLimitName,
} from "@adclub/contracts";
import { maskPhone, normalizeKzMobilePhone } from "@adclub/domain";
import { z } from "zod";
import {
  APP_CONFIG,
  type AppConfig,
  type LoginCodeSettings,
  type RateLimitSettings,
} from "../../../config";
import type { DbExecutor } from "../../../database";
import {
  ApiException,
  rateLimitedException,
  serviceUnavailableException,
} from "../../../common/errors";
import { ZodValidationException } from "../../../common/validation";
import { RateLimiterService, RateLimiterUnavailableError } from "../../../redis";
import { LoginCodeChannels, LoginCodeDeliveryError } from "./channels/login-code-channels";
import { rateLimitSubject } from "./rate-limit-subject";
import {
  generateLoginCode,
  hashLoginCode,
  loginCodeMatches,
  verifyDelaySeconds,
} from "./login-code.crypto";
import { LoginCodeSettingsSource } from "./login-code-settings.source";
import { LoginCodeStore } from "./login-code.store";

export interface RequestLoginCodeInput {
  phone: string;
  channel?: LoginCodeChannel;
  ip: string;
}

export interface VerifyLoginCodeInput {
  phone: string;
  code: string;
}

/**
 * A phone number confirmed by a code. Returned exactly once per code: the
 * code is consumed in the same transaction. TASK-005 issues the session
 * from this value inside the same `verify` request.
 */
export interface VerifiedPhone {
  phone: string;
  /** The channel the confirmed code was delivered through. */
  channel: LoginCodeChannel;
  challengeId: string;
}

type VerifyOutcome =
  | { kind: "verified"; verified: VerifiedPhone }
  | { kind: "no_code" }
  | { kind: "expired" }
  | { kind: "wait"; retryAfterSeconds: number }
  | { kind: "invalid"; attemptsRemaining: number };

const keys = {
  requestsPerPhone: (phone: string) => `login-code:requests:phone:${phone}`,
  requestsPerIp: (subject: string) => `login-code:requests:ip:${subject}`,
  resend: (phone: string) => `login-code:resend:${phone}`,
  smsPerPhone: (phone: string) => `login-code:sms:phone:${phone}`,
  smsPerIp: (subject: string) => `login-code:sms:ip:${subject}`,
  verificationsPerPhone: (phone: string) => `login-code:verifications:phone:${phone}`,
};

function phoneValidationError(input: string): ZodValidationException {
  return new ZodValidationException(
    new z.ZodError([
      {
        code: "custom",
        path: ["phone"],
        message: "Must be a Kazakhstan mobile number (+7 7xx xxx xx xx)",
        input,
      },
    ]),
  );
}

/**
 * One-time login codes (ARCHITECTURE 8.1): issue a code, deliver it
 * WhatsApp-first with SMS fallback, check it, and resist brute force and
 * paid-message flooding. The code never leaves this service except to the
 * channel; logs carry a masked phone number only.
 */
@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger("LoginCode");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LoginCodeSettingsSource) private readonly settingsSource: LoginCodeSettingsSource,
    @Inject(LoginCodeChannels) private readonly channels: LoginCodeChannels,
    @Inject(LoginCodeStore) private readonly store: LoginCodeStore,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
  ) {}

  async requestCode(input: RequestLoginCodeInput): Promise<LoginCodeSentResponse> {
    const phone = normalizeKzMobilePhone(input.phone);
    if (!phone) {
      throw phoneValidationError(input.phone);
    }
    const masked = maskPhone(phone);
    const ipSubject = rateLimitSubject(input.ip);
    const settings = await this.settingsSource.getSettings();
    this.log(`Login code requested phone=${masked} channel=${input.channel ?? "auto"}`);

    return this.withRateLimiter(async () => {
      // Counted before anything else, so rejected and concurrent requests
      // count too.
      await this.enforce(
        keys.requestsPerIp(ipSubject),
        settings.requestsPerIp,
        "login_code_requests_per_ip",
        masked,
      );
      await this.enforce(
        keys.requestsPerPhone(phone),
        settings.requestsPerPhone,
        "login_code_requests_per_phone",
        masked,
      );

      // One code per resend interval for a number, whatever the channel:
      // also makes concurrent requests for one number mutually exclusive.
      const lock = await this.rateLimiter.acquireOnce(
        keys.resend(phone),
        settings.resendIntervalSeconds,
      );
      if (!lock.acquired) {
        this.logLimit("login_code_resend_interval", masked);
        throw rateLimitedException("login_code_resend_interval", lock.retryAfterSeconds);
      }

      try {
        return await this.issue(phone, masked, ipSubject, input.channel, settings);
      } catch (error) {
        // Nothing usable reached the person: don't keep them waiting for a
        // resend, and don't count the attempt against them — unless a
        // limit is what stopped it.
        await this.rateLimiter.undo(() => this.rateLimiter.release(keys.resend(phone)));
        if (!(error instanceof ApiException && error.code === "RATE_LIMITED")) {
          await this.rateLimiter.undo(() => this.rateLimiter.refund(keys.requestsPerPhone(phone)));
          await this.rateLimiter.undo(() => this.rateLimiter.refund(keys.requestsPerIp(ipSubject)));
        }
        throw error;
      }
    });
  }

  async verifyCode(input: VerifyLoginCodeInput): Promise<VerifiedPhone> {
    return (await this.verifyCodeAnd(input, () => Promise.resolve(undefined))).verified;
  }

  /**
   * Checks the code and, if it's right, runs `complete` in the transaction
   * that spends it: either both happen or neither (a failure in `complete`
   * leaves the code usable).
   */
  async verifyCodeAnd<U>(
    input: VerifyLoginCodeInput,
    complete: (verified: VerifiedPhone, tx: DbExecutor) => Promise<U>,
  ): Promise<{ verified: VerifiedPhone; completed: U }> {
    const phone = normalizeKzMobilePhone(input.phone);
    if (!phone) {
      throw phoneValidationError(input.phone);
    }
    const masked = maskPhone(phone);
    const settings = await this.settingsSource.getSettings();

    await this.withRateLimiter(() =>
      this.enforce(
        keys.verificationsPerPhone(phone),
        settings.verificationsPerPhone,
        "login_code_verifications_per_phone",
        masked,
      ),
    );

    const now = new Date();
    let confirmed: VerifiedPhone | undefined;
    const attempt = await this.store.attemptVerification<VerifyOutcome, U>(
      phone,
      now,
      (challenge) => {
        if (!challenge) {
          return { result: { kind: "no_code" } };
        }
        if (challenge.expiresAt.getTime() <= now.getTime()) {
          return { decision: { kind: "expire" }, result: { kind: "expired" } };
        }
        if (challenge.nextAttemptAt && challenge.nextAttemptAt.getTime() > now.getTime()) {
          // Too early after a wrong entry: not counted as an attempt.
          return {
            result: {
              kind: "wait",
              retryAfterSeconds: (challenge.nextAttemptAt.getTime() - now.getTime()) / 1000,
            },
          };
        }
        if (
          loginCodeMatches(
            this.config.loginCode.hashSecret,
            challenge.id,
            input.code,
            challenge.codeHash,
          )
        ) {
          confirmed = { phone, channel: challenge.channel, challengeId: challenge.id };
          return {
            decision: { kind: "consume" },
            result: { kind: "verified", verified: confirmed },
          };
        }
        const failures = challenge.attempts + 1;
        const attemptsRemaining = Math.max(0, challenge.maxAttempts - failures);
        const delay = verifyDelaySeconds(
          failures,
          settings.verifyFreeFailures,
          settings.verifyDelayBaseSeconds,
        );
        return {
          decision: {
            kind: "fail",
            exhausted: attemptsRemaining === 0,
            nextAttemptAt: delay > 0 ? new Date(now.getTime() + delay * 1000) : null,
          },
          result: { kind: "invalid", attemptsRemaining },
        };
      },
      (tx) => {
        if (!confirmed) {
          throw new Error("A code was consumed without a verified phone");
        }
        return complete(confirmed, tx);
      },
    );

    const outcome = attempt.result;
    switch (outcome.kind) {
      case "verified":
        this.log(`Login code verified phone=${masked} channel=${outcome.verified.channel}`);
        return { verified: outcome.verified, completed: attempt.consumed as U };
      case "no_code":
      case "expired":
        this.log(
          `Login code verification failed phone=${masked} reason=${outcome.kind === "expired" ? "expired" : "no_active_code"}`,
        );
        throw new ApiException(
          400,
          "LOGIN_CODE_EXPIRED",
          "The code is no longer valid, request a new one",
        );
      case "wait":
        this.logLimit("login_code_verify_delay", masked);
        throw rateLimitedException("login_code_verify_delay", outcome.retryAfterSeconds);
      case "invalid": {
        this.log(
          `Login code verification failed phone=${masked} reason=wrong_code attemptsRemaining=${outcome.attemptsRemaining}`,
        );
        const details: LoginCodeInvalidDetails = { attemptsRemaining: outcome.attemptsRemaining };
        throw new ApiException(400, "LOGIN_CODE_INVALID", "The code is incorrect", { details });
      }
    }
  }

  private async issue(
    phone: string,
    masked: string,
    ipSubject: string,
    requestedChannel: LoginCodeChannel | undefined,
    settings: LoginCodeSettings,
  ): Promise<LoginCodeSentResponse> {
    if (requestedChannel === "sms") {
      await this.enforceSms(phone, masked, ipSubject, settings);
    }

    const id = randomUUID();
    const code = generateLoginCode(settings.codeLength);
    const createdAt = new Date();
    await this.store.createPending({
      id,
      phone,
      codeHash: hashLoginCode(this.config.loginCode.hashSecret, id, code),
      maxAttempts: settings.maxAttempts,
      expiresAt: new Date(createdAt.getTime() + settings.ttlSeconds * 1000),
    });

    let channel: LoginCodeChannel;
    let expiresAt: Date;
    try {
      // The code expires `ttlSeconds` after it was sent, not after the
      // request started (a slow provider must not eat into the lifetime).
      const send = async (target: LoginCodeChannel) => {
        const sentAt = new Date();
        const messageExpiresAt = new Date(sentAt.getTime() + settings.ttlSeconds * 1000);
        await this.channels.sender(target).send({ phone, code, expiresAt: messageExpiresAt });
        return messageExpiresAt;
      };

      if (requestedChannel === "sms") {
        expiresAt = await this.deliver("sms", masked, () => send("sms"));
        channel = "sms";
      } else {
        try {
          expiresAt = await this.deliver("whatsapp", masked, () => send("whatsapp"));
          channel = "whatsapp";
        } catch (error) {
          if (!(error instanceof DeliveryFailed)) {
            throw error;
          }
          this.log(`Login code falling back to sms phone=${masked}`);
          await this.enforceSms(phone, masked, ipSubject, settings);
          expiresAt = await this.deliver("sms", masked, () => send("sms"));
          channel = "sms";
        }
      }
    } catch (error) {
      await this.store.markFailed(id, new Date());
      if (error instanceof DeliveryFailed) {
        this.logger.warn(`Login code not delivered by any channel phone=${masked}`);
        throw new ApiException(
          503,
          "LOGIN_CODE_DELIVERY_FAILED",
          "The code could not be delivered, try again later",
          { retryable: true },
        );
      }
      throw error;
    }

    const now = new Date();
    await this.store.activate(id, phone, channel, now, expiresAt);
    return {
      phone,
      channel,
      codeLength: settings.codeLength,
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: new Date(
        createdAt.getTime() + settings.resendIntervalSeconds * 1000,
      ).toISOString(),
    };
  }

  /** Sends through one channel; a failure becomes `DeliveryFailed` (logged, never with the code). */
  private async deliver<T>(
    channel: LoginCodeChannel,
    masked: string,
    send: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await send();
      this.log(`Login code delivered phone=${masked} channel=${channel}`);
      return result;
    } catch (error) {
      // Provider errors may echo the message: log only a safe reason.
      const reason = error instanceof LoginCodeDeliveryError ? error.reason : "unexpected_error";
      this.logger.warn(
        `Login code delivery failed phone=${masked} channel=${channel} reason=${reason}`,
      );
      throw new DeliveryFailed();
    }
  }

  private async enforceSms(
    phone: string,
    masked: string,
    ipSubject: string,
    settings: LoginCodeSettings,
  ): Promise<void> {
    await this.enforce(
      keys.smsPerPhone(phone),
      settings.smsPerPhoneDaily,
      "login_code_sms_per_phone_daily",
      masked,
    );
    await this.enforce(
      keys.smsPerIp(ipSubject),
      settings.smsPerIpDaily,
      "login_code_sms_per_ip_daily",
      masked,
    );
  }

  private async enforce(
    key: string,
    limit: RateLimitSettings,
    name: RateLimitName,
    masked: string,
  ): Promise<void> {
    const hit = await this.rateLimiter.hit(key, limit);
    if (!hit.allowed) {
      this.logLimit(name, masked);
      throw rateLimitedException(name, hit.retryAfterSeconds);
    }
  }

  /** Redis down: refuse rather than issue codes without limits. */
  private async withRateLimiter<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        this.logger.warn(`Login code refused: ${error.message}`);
        throw serviceUnavailableException();
      }
      throw error;
    }
  }

  private log(message: string): void {
    this.logger.log(message);
  }

  private logLimit(name: RateLimitName, masked: string): void {
    this.logger.warn(`Login code rate limit hit limit=${name} phone=${masked}`);
  }
}

/** Internal: one channel failed to deliver (details already logged). */
class DeliveryFailed extends Error {
  constructor() {
    super("Login code delivery failed");
    this.name = "DeliveryFailed";
  }
}
