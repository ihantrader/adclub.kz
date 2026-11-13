import type { PushTarget } from "../start/start-decision";

/**
 * Push to the user, the pure part (TASK-051; SCREENS M-PUSH-01, M-PRO-04,
 * 5.1 rule 6; ARCHITECTURE 4.79): what a push carries, when the sheet that
 * asks for the permission is shown, what the profile says. Checked by tests
 * without React Native.
 */

export type PushPermissionStatus = "granted" | "denied" | "undetermined";

export interface PushPermission {
  status: PushPermissionStatus;
  /** The system may still show its dialog (iOS asks once; Android 13+ twice). */
  canAskAgain: boolean;
}

/** A push as the app sees it: which notification, and what it opens. */
export interface PushMessage {
  /** The id the app confirms it by; `null` — not one of ours. */
  notificationId: string | null;
  target: PushTarget | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The data of a push (`notificationId`, `target` — JSON, FCM data values are
 * strings) as the app understands it. Anything else — a malformed target, a
 * screen this version does not know — opens nothing.
 */
export function pushMessageOf(data: unknown): PushMessage {
  const record = (data ?? {}) as Record<string, unknown>;
  const id = typeof record.notificationId === "string" && UUID.test(record.notificationId);
  return {
    notificationId: id ? (record.notificationId as string) : null,
    target: targetOf(record.target),
  };
}

function targetOf(raw: unknown): PushTarget | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const target = (value ?? {}) as { screen?: unknown; params?: { orderId?: unknown } };
  if (target.screen === "order") {
    const orderId = target.params?.orderId;
    return typeof orderId === "string" && UUID.test(orderId)
      ? { screen: "order", params: { orderId } }
      : null;
  }
  if (target.screen === "subscription") {
    return { screen: "subscription" };
  }
  if (target.screen === "catalog") {
    const carId = (target.params as { carId?: unknown } | undefined)?.carId;
    return typeof carId === "string" && UUID.test(carId)
      ? { screen: "catalog", params: { carId } }
      : null;
  }
  return null;
}

/** M-PUSH-01 is shown at most this many times per account on this device. */
export const PUSH_OFFER_LIMIT = 2;

/**
 * Whether M-PUSH-01 is shown after an order was placed: push is not allowed
 * yet, the system can still ask, and the sheet has not been shown twice to
 * this account on this device («Не сейчас» — again after the next order, no
 * more than twice). Allowed, or refused by the system for good — never.
 */
export function shouldOfferPush(permission: PushPermission | null, offeredTimes: number): boolean {
  if (!permission) return false;
  if (permission.status === "granted") return false;
  if (!permission.canAskAgain) return false;
  return offeredTimes < PUSH_OFFER_LIMIT;
}

/** How many times each account was offered push on this device. */
export type PushOffers = Readonly<Record<string, number>>;

export function parsePushOffers(raw: unknown): PushOffers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const offers: Record<string, number> = {};
  for (const [account, times] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof times === "number" && Number.isInteger(times) && times >= 0) {
      offers[account] = Math.min(times, PUSH_OFFER_LIMIT);
    }
  }
  return offers;
}

export function offeredOnce(offers: PushOffers, accountId: string): PushOffers {
  return { ...offers, [accountId]: Math.min((offers[accountId] ?? 0) + 1, PUSH_OFFER_LIMIT) };
}

/**
 * Whether the app may promise a push on the screen of an order («Сообщим,
 * когда можно забирать», I455): only where one really goes and only to a
 * person whose push is allowed.
 */
export function pushPromised(permission: PushPermission | null): boolean {
  return permission?.status === "granted";
}

/** The key of what was sent to the server last: the same token of the same session is not sent twice. */
export function registrationKey(sessionId: string, token: string): string {
  return `${sessionId}:${token}`;
}
