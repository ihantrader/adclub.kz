import { isApiError } from "@adclub/api-client";
import { PHOTO_CONTENT_TYPES, type ItemPhotoStatus } from "@adclub/contracts";
import type { StatusTone } from "../price/price-rules";
import { retryMinutes } from "../errors";
import type { Translate } from "../i18n";

/**
 * What the cabinet decides about a supplier's photo (TASK-068; S-OFF-03,
 * S-OFF-05, S-MOD-01): the words of its status and of a refusal. The server
 * checks the file by its content; here only the words.
 */

/** «На рассмотрении» / «Фото принято» / «Отклонено: {причина}» / «Фото убрано». */
export function photoStatusText(
  status: ItemPhotoStatus,
  reason: string | null,
  t: Translate,
): string {
  switch (status) {
    case "proposed":
      return t("moderation.status.waiting");
    case "approved":
      return t("moderation.status.photoAccepted");
    case "rejected":
      return reason
        ? t("moderation.status.rejected", { reason })
        : t("moderation.status.rejectedPlain");
    case "deleted":
      return t("moderation.status.photoRemoved");
  }
}

export function photoStatusTone(status: ItemPhotoStatus): StatusTone {
  return status === "approved" ? "success" : status === "proposed" ? "warning" : "danger";
}

/** A file the server takes: the browser says its type; anything else is refused before sending. */
export function acceptedPhotoType(type: string): boolean {
  return (PHOTO_CONTENT_TYPES as readonly string[]).includes(type);
}

/** A refused upload, in words. */
export function photoRefusal(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t("photo.failed");
  switch (error.code) {
    case "CATALOG_PHOTO_INVALID": {
      const reason = (error.details as { reason?: unknown } | undefined)?.reason;
      return reason === "too_many_photos" ? t("request.photos") : t("photo.invalid");
    }
    case "UNSUPPORTED_MEDIA_TYPE":
      return t("photo.invalid");
    case "PAYLOAD_TOO_LARGE":
      return t("photo.tooLarge");
    case "RATE_LIMITED":
      return t("photo.tooMany", { minutes: retryMinutes(error) });
    case "CATALOG_PHOTO_NOT_NEEDED":
      return t("photo.notNeeded");
    case "NETWORK_ERROR":
      return t("common.saveOffline");
    default:
      return t("photo.failed");
  }
}
