import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RateLimitSettings } from "../config";
import { describeError } from "../common/health/describe-error";
import { withTimeout } from "../common/health/with-timeout";
import { RedisService } from "./redis.service";

/** Redis didn't answer: callers must fail closed, never skip the limit. */
export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Rate limiter unavailable: ${describeError(cause)}`, { cause });
    this.name = "RateLimiterUnavailableError";
  }
}

export interface RateLimitHit {
  allowed: boolean;
  /** Current count in the window, this hit included. */
  count: number;
  /** Seconds until the window resets (a rejected caller may retry then). */
  retryAfterSeconds: number;
}

export interface OnceLock {
  acquired: boolean;
  /** When not acquired: seconds until the current holder expires. */
  retryAfterSeconds: number;
}

const KEY_PREFIX = "rl:";
const COMMAND_TIMEOUT_MS = 1000;

// Fixed window starting at the first hit. The TTL is re-armed if it was
// ever lost, so a counter can't outlive its window forever.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const REFUND_SCRIPT = `
if redis.call('GET', KEYS[1]) and tonumber(redis.call('GET', KEYS[1])) > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

/**
 * Counters and one-at-a-time locks in Redis (ARCHITECTURE 3.4, 8.1),
 * shared by every API instance. Every operation fails with
 * `RateLimiterUnavailableError` when Redis is down or slow, so a limit is
 * never silently skipped.
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /** Counts one hit; `allowed` is false once the count exceeds `limit.max`. */
  async hit(key: string, limit: RateLimitSettings): Promise<RateLimitHit> {
    const [count, ttlMs] = (await this.run(() =>
      this.redis.client.eval(HIT_SCRIPT, 1, KEY_PREFIX + key, limit.windowSeconds * 1000),
    )) as [number, number];
    return {
      allowed: count <= limit.max,
      count,
      retryAfterSeconds: Math.ceil(ttlMs / 1000),
    };
  }

  /** Takes back one hit, e.g. when the counted action didn't happen. */
  async refund(key: string): Promise<void> {
    await this.run(() => this.redis.client.eval(REFUND_SCRIPT, 1, KEY_PREFIX + key));
  }

  /** Succeeds for one caller per `seconds`; the others learn how long to wait. */
  async acquireOnce(key: string, seconds: number): Promise<OnceLock> {
    const fullKey = KEY_PREFIX + key;
    const result = await this.run(() =>
      this.redis.client.set(fullKey, "1", "PX", seconds * 1000, "NX"),
    );
    if (result === "OK") {
      return { acquired: true, retryAfterSeconds: 0 };
    }
    const ttlMs = await this.run(() => this.redis.client.pttl(fullKey));
    return { acquired: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
  }

  async release(key: string): Promise<void> {
    await this.run(() => this.redis.client.del(KEY_PREFIX + key));
  }

  /**
   * Best-effort undo (refund/release) after a failed action: the caller is
   * already failing for another reason, so an error here is only logged.
   */
  async undo(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.warn(`Could not undo a rate limit step: ${describeError(error)}`);
    }
  }

  private async run<T>(command: () => Promise<T>): Promise<T> {
    // A disconnected client would queue the command until it reconnects;
    // answer right away instead.
    if (this.redis.client.status !== "ready") {
      throw new RateLimiterUnavailableError(
        new Error(`Redis connection is ${this.redis.client.status}, not ready`),
      );
    }
    try {
      return await withTimeout(command(), COMMAND_TIMEOUT_MS);
    } catch (error) {
      throw new RateLimiterUnavailableError(error);
    }
  }
}
