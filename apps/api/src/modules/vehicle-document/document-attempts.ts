import { Inject, Injectable } from "@nestjs/common";
import type { RateLimitName, VehicleDocumentAttempts } from "@adclub/contracts";
import { rateLimitedException, serviceUnavailableException } from "../../common/errors";
import { RateLimiterService, RateLimiterUnavailableError, rateLimitSubject } from "../../redis";
import { AppSettings } from "../settings";

/**
 * Who reads a certificate, as the limits see it (TASK-057): a signed-in
 * person by the account; a guest by the device the app made an id for and
 * by the address the request came from.
 */
export type DocumentReader =
  | { kind: "account"; accountId: string }
  | { kind: "guest"; deviceId: string; ip: string | undefined };

/**
 * A guest's trial recognitions don't run out with a day (PRODUCT 6.6: «три
 * пробных распознавания», `guest_limits.photo_recognitions`): the window of
 * a device is effectively for good — a year, so Redis still forgets a
 * device nobody uses.
 */
const DEVICE_WINDOW_SECONDS = 365 * 24 * 60 * 60;

interface Bucket {
  limit: RateLimitName;
  key: string;
  max: number;
  windowSeconds: number;
}

/** What was counted for one attempt — handed back when the attempt did not happen. */
export interface CountedAttempt {
  keys: string[];
  attempts: VehicleDocumentAttempts;
}

/**
 * The attempts of reading a certificate, counted by hand rather than by the
 * guard of the contract (ARCHITECTURE 4.58): the answer says how many are
 * left (T-GAR-04), and an attempt the provider could not serve — down, or
 * the day's budget spent — is given back, because that is not the person's
 * fault. Without Redis nothing is read: every attempt costs money, and an
 * uncounted one is not allowed (as the request form, 4.26).
 */
@Injectable()
export class DocumentAttempts {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(RateLimiterService) private readonly limiter: RateLimiterService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  /** How many are left now, nothing counted. */
  async left(reader: DocumentReader): Promise<VehicleDocumentAttempts> {
    const buckets = await this.bucketsOf(reader);
    try {
      const counts = await Promise.all(buckets.map((bucket) => this.limiter.peek(bucket.key)));
      return this.attemptsOf(
        reader,
        buckets,
        counts.map((count) => count.count),
      );
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) throw serviceUnavailableException();
      throw error;
    }
  }

  /**
   * Counts one attempt in every bucket of the reader; over any of them —
   * 429 with `Retry-After`, and what this call counted is taken back.
   */
  async count(reader: DocumentReader): Promise<CountedAttempt> {
    const buckets = await this.bucketsOf(reader);
    const counted: string[] = [];
    const counts: number[] = [];
    try {
      for (const bucket of buckets) {
        const hit = await this.limiter.hit(bucket.key, {
          max: bucket.max,
          windowSeconds: bucket.windowSeconds,
        });
        counted.push(bucket.key);
        counts.push(hit.count);
        if (!hit.allowed) {
          await this.giveBack(counted);
          throw rateLimitedException(bucket.limit, hit.retryAfterSeconds);
        }
      }
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        await this.giveBack(counted);
        throw serviceUnavailableException();
      }
      throw error;
    }
    return { keys: counted, attempts: this.attemptsOf(reader, buckets, counts) };
  }

  /** Takes an attempt back (the provider could not serve it); best effort. */
  async giveBack(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await this.limiter.undo(() => this.limiter.refund(key));
    }
  }

  /** The attempts as the answer says them after giving one back. */
  refunded(attempts: VehicleDocumentAttempts): VehicleDocumentAttempts {
    return { ...attempts, remaining: Math.min(attempts.limit, attempts.remaining + 1) };
  }

  private attemptsOf(
    reader: DocumentReader,
    buckets: readonly Bucket[],
    counts: readonly number[],
  ): VehicleDocumentAttempts {
    const first = buckets[0]!;
    const remaining = Math.min(
      ...buckets.map((bucket, index) => Math.max(0, bucket.max - (counts[index] ?? 0))),
    );
    return {
      scope: reader.kind === "account" ? "account" : "guest",
      remaining,
      limit: first.max,
    };
  }

  private async bucketsOf(reader: DocumentReader): Promise<Bucket[]> {
    if (reader.kind === "account") {
      const [max, windowSeconds] = await Promise.all([
        this.settings.get("vehicle_document_per_account"),
        this.settings.get("vehicle_document_per_account_window_seconds"),
      ]);
      return [
        {
          limit: "vehicle_document_per_account",
          key: `vehicle-document:account:${reader.accountId}`,
          max,
          windowSeconds,
        },
      ];
    }
    const [guest, ipMax, ipWindow] = await Promise.all([
      this.settings.get("guest_limits"),
      this.settings.get("vehicle_document_per_ip"),
      this.settings.get("vehicle_document_per_ip_window_seconds"),
    ]);
    return [
      {
        limit: "vehicle_document_per_device",
        key: `vehicle-document:device:${reader.deviceId}`,
        max: guest.photo_recognitions,
        windowSeconds: DEVICE_WINDOW_SECONDS,
      },
      {
        limit: "vehicle_document_per_ip",
        key: `vehicle-document:ip:${rateLimitSubject(reader.ip)}`,
        max: ipMax,
        windowSeconds: ipWindow,
      },
    ];
  }
}
