import { z } from "zod";

/**
 * Push notifications to the user (TASK-051; PRODUCT 15; SCREENS 8.4,
 * M-PUSH-01, M-PRO-04; ARCHITECTURE 9.3, 4.79).
 */

/**
 * Every kind of notification to the user — the one list: the setting
 * `critical_notification_kinds` takes its values from it, the server's
 * entrance `Notifications.enqueue` takes a kind from it, and the admin
 * panel names each of them. `maintenance_reminder` is for stage D.
 */
export const notificationKinds = [
  "order_accepted",
  "order_ready",
  "order_confirmed",
  "order_declined",
  "order_expired_no_response",
  "term_proposed",
  "time_proposed",
  "reserve_expiring",
  "order_closed",
  "supply_overdue",
  "review_text_rejected",
  "maintenance_reminder",
  "payment_failed",
] as const;

export const notificationKindSchema = z.enum(notificationKinds);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * What a push opens (`PushTarget` of the app): an order — M-ORD-03; the
 * subscription — the profile until M-SUB-02 exists (TASK-041). Only a
 * screen and an id: the push itself carries nothing else.
 */
export const pushTargetSchema = z.discriminatedUnion("screen", [
  z.object({ screen: z.literal("order"), params: z.object({ orderId: z.uuid() }) }),
  z.object({ screen: z.literal("subscription"), params: z.object({}).optional() }),
]);
export type PushTargetValue = z.infer<typeof pushTargetSchema>;

export const pushPlatformSchema = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof pushPlatformSchema>;

/**
 * The device's push token, given by the platform (FCM registration token).
 * Bound to the session that sends it: the session's end takes the device
 * off every push at once (ARCHITECTURE 4.79).
 */
export const registerPushTokenBodySchema = z.object({
  platform: pushPlatformSchema,
  token: z
    .string()
    .trim()
    .min(16)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/, "A push token is printable ASCII without spaces"),
  /** The model of the device («iPhone 15», «SM-A546E») — nothing about the person. */
  deviceModel: z.string().trim().max(100).nullable().optional(),
});
export type RegisterPushTokenBody = z.infer<typeof registerPushTokenBodySchema>;

export const pushTokenResponseSchema = z.object({
  registered: z.boolean(),
  platform: pushPlatformSchema.nullable(),
});
export type PushTokenResponse = z.infer<typeof pushTokenResponseSchema>;

export const notificationPathSchema = z.object({ notificationId: z.uuid() });
export type NotificationPath = z.infer<typeof notificationPathSchema>;

export const notificationAckResponseSchema = z.object({
  notificationId: z.uuid(),
  ackedAt: z.iso.datetime(),
});
export type NotificationAckResponse = z.infer<typeof notificationAckResponseSchema>;

export const orderNotificationsAckResponseSchema = z.object({
  /** How many notifications of the order this confirmed (0 — none was waiting). */
  acked: z.number().int().min(0),
});
export type OrderNotificationsAckResponse = z.infer<typeof orderNotificationsAckResponseSchema>;
