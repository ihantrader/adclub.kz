import { Inject, Injectable } from "@nestjs/common";
import { RateLimiterService, rateLimitSubject } from "../../redis";
import { AppSettings } from "../settings";
import {
  DEVICE_WINDOW_SECONDS,
  RecognitionAttempts,
  type Bucket,
  type DocumentReader,
} from "../vehicle-document";

/**
 * The attempts of voice input (TASK-059; ARCHITECTURE 4.90), counted as the
 * photos are (`RecognitionAttempts`) but in buckets of their own: a guest's
 * trial voice requests per device, for good (`guest_limits.voice_requests`,
 * PRODUCT 6.6), and per address against a device id made anew; a signed-in
 * person's per account and day. The answer says how many are left; an
 * attempt the provider could not serve is given back.
 */
@Injectable()
export class SpeechAttempts extends RecognitionAttempts {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(RateLimiterService) limiter: RateLimiterService,
    @Inject(AppSettings) settings: AppSettings,
  ) {
    super(limiter, settings);
  }

  protected async bucketsOf(reader: DocumentReader): Promise<Bucket[]> {
    if (reader.kind === "account") {
      const [max, windowSeconds] = await Promise.all([
        this.settings.get("speech_per_account"),
        this.settings.get("speech_per_account_window_seconds"),
      ]);
      return [
        {
          limit: "speech_per_account",
          key: `speech:account:${reader.accountId}`,
          max,
          windowSeconds,
        },
      ];
    }
    const [guest, ipMax, ipWindow] = await Promise.all([
      this.settings.get("guest_limits"),
      this.settings.get("speech_per_ip"),
      this.settings.get("speech_per_ip_window_seconds"),
    ]);
    return [
      {
        limit: "speech_per_device",
        key: `speech:device:${reader.deviceId}`,
        max: guest.voice_requests,
        windowSeconds: DEVICE_WINDOW_SECONDS,
      },
      {
        limit: "speech_per_ip",
        key: `speech:ip:${rateLimitSubject(reader.ip)}`,
        max: ipMax,
        windowSeconds: ipWindow,
      },
    ];
  }
}
