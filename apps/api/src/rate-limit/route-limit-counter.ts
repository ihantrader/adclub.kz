import { Logger } from "@nestjs/common";
import type { ApiRouteDefinition, RateLimitName } from "@adclub/contracts";
import { rateLimitedException, serviceUnavailableException } from "../common/errors";
import { AppSettings, isSettingKey, type SettingKey } from "../modules/settings";
import { Metrics } from "../observability";
import { RateLimiterService, RateLimiterUnavailableError } from "../redis";

/** How often a served request without a working limiter is reported (not every request). */
const UNAVAILABLE_WARNING_INTERVAL_MS = 60_000;

/** The settings of a limit: `<limit>` (how many) and `<limit>_window_seconds` (per how long). */
export function rateLimitSettingKeys(limit: RateLimitName): [SettingKey, SettingKey] {
  const max = limit;
  const window = `${limit}_window_seconds`;
  if (!isSettingKey(max) || !isSettingKey(window)) {
    throw new Error(`The rate limit ${limit} has no settings ${max} and ${window}`);
  }
  return [max, window];
}

/**
 * How a route's limit is counted before its body is read
 * (`UploadRateLimitMiddleware`) rather than by the guard; `null` — by the
 * guard. Only a route that takes a file: its body is read by a middleware,
 * before any guard.
 *
 * - `address` (TASK-059.A) — a limit by address only;
 * - `account` (TASK-064.A) — a session route counted `perAccount`: the
 *   account is taken from the signature of the access token, without the
 *   database, so a body of up to tens of megabytes is never read for a
 *   request over its limit or without a valid token. A limit `perMember`
 *   needs the membership, which only the guard knows; it keeps the guard.
 */
export function beforeBodyCount(
  route: Pick<ApiRouteDefinition, "upload" | "rateLimit"> &
    Partial<Pick<ApiRouteDefinition, "auth">>,
): { by: "address" | "account"; limit: RateLimitName } | null {
  const spec = route.rateLimit;
  if (!route.upload || !spec || spec.perMember) return null;
  if (spec.limit && !spec.perAccount) return { by: "address", limit: spec.limit };
  if (spec.perAccount && route.auth === "session") return { by: "account", limit: spec.perAccount };
  return null;
}

/** Whether `UploadRateLimitMiddleware` counted the route's limit and the guard leaves it alone. */
export function countedBeforeBody(
  route: Pick<ApiRouteDefinition, "upload" | "rateLimit"> &
    Partial<Pick<ApiRouteDefinition, "auth">>,
): boolean {
  return beforeBodyCount(route) !== null;
}

/**
 * One hit of a route's limit (ARCHITECTURE 4.33): the size from the
 * settings, the bucket in Redis, 429 `RATE_LIMITED` with `Retry-After` over
 * it, and what happens without Redis. Shared by `RouteRateLimitGuard` and,
 * for the address of an upload route, by `UploadRateLimitMiddleware`, which
 * must count before the body is read (TASK-059.A) — one way of counting.
 */
export class RouteLimitCounter {
  private readonly logger = new Logger("RateLimit");
  /** When each limit last reported serving without Redis. */
  private readonly lastUnavailableWarning = new Map<RateLimitName, number>();

  // A plain class: each guard and middleware that counts builds its own from
  // the global services, so no module has to provide it.
  constructor(
    private readonly limiter: RateLimiterService,
    private readonly settings: AppSettings,
    private readonly metrics: Metrics,
  ) {}

  /** Counts one request; throws 429 over the limit, 503 without Redis when it must refuse. */
  async hit(input: {
    limit: RateLimitName;
    subject: string;
    whenUnavailable: "refuse" | "allow";
    /** For the log line: the operation or the path. */
    route: string;
  }): Promise<void> {
    const [maxKey, windowKey] = rateLimitSettingKeys(input.limit);
    const [max, windowSeconds] = await Promise.all([
      this.settings.get(maxKey),
      this.settings.get(windowKey),
    ]);
    const key = `route:${input.limit}:${input.subject}`;
    let allowed: boolean;
    let retryAfterSeconds: number;
    try {
      ({ allowed, retryAfterSeconds } = await this.limiter.hit(key, {
        max: max as number,
        windowSeconds: windowSeconds as number,
      }));
    } catch (error) {
      if (!(error instanceof RateLimiterUnavailableError)) {
        throw error;
      }
      if (input.whenUnavailable === "refuse") {
        this.logger.warn(`Refused without the limit limit=${input.limit}: ${error.message}`);
        throw serviceUnavailableException();
      }
      this.warnServedUnlimited(input.limit, error);
      return;
    }
    if (!allowed) {
      this.metrics.countRateLimitHit(input.limit);
      // No address, account or employee in the line: the limit and the route say enough.
      this.logger.warn(`Rate limit hit limit=${input.limit} route=${input.route}`);
      throw rateLimitedException(input.limit, retryAfterSeconds);
    }
  }

  private warnServedUnlimited(limit: RateLimitName, error: Error): void {
    const now = Date.now();
    if (now - (this.lastUnavailableWarning.get(limit) ?? 0) < UNAVAILABLE_WARNING_INTERVAL_MS) {
      return;
    }
    this.lastUnavailableWarning.set(limit, now);
    this.logger.warn(`Served without the limit limit=${limit}: ${error.message}`);
  }
}
