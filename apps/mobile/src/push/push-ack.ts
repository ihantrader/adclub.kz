import { isApiError } from "@adclub/api-client";
import { pushMessageOf } from "./push-logic";

/**
 * Confirming a push (TASK-051, TASK-056; ARCHITECTURE 4.79, 4.81, I862,
 * I866), the pure part: what a confirmation that failed becomes, the
 * confirmations left for later, and what the background task of
 * `expo-notifications` confirms. Checked by tests without React Native.
 */

/**
 * What became of one `POST /notifications/{id}/ack`:
 * - `done` — confirmed;
 * - `drop` — the server answered and the answer will not change (a 4xx:
 *   someone else's or a missing push — 404, the session ended — 401, a
 *   refusal): asking again only repeats it, so it leaves the queue (I866);
 * - `retry` — no answer worth believing (no network, a timeout, 5xx, 408,
 *   429): tried once more at the next return of the app.
 */
export type AckOutcome = "done" | "drop" | "retry";

export function ackOutcomeOf(error: unknown): AckOutcome {
  if (error === undefined) return "done";
  if (!isApiError(error)) return "retry";
  const { status } = error;
  if (status === 0 || status === 408 || status === 429 || status >= 500) return "retry";
  return status >= 400 ? "drop" : "retry";
}

/** The confirmations waiting for the next return — at most this many, the newest kept. */
export const PENDING_ACKS_LIMIT = 50;

export type PendingAcks = readonly string[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePendingAcks(raw: unknown): PendingAcks {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(raw.filter((id): id is string => typeof id === "string" && UUID.test(id))),
  ].slice(-PENDING_ACKS_LIMIT);
}

export function withPendingAck(list: PendingAcks, id: string): PendingAcks {
  return [...list.filter((entry) => entry !== id), id].slice(-PENDING_ACKS_LIMIT);
}

export function withoutPendingAck(list: PendingAcks, id: string): PendingAcks {
  return list.filter((entry) => entry !== id);
}

/**
 * The notification a payload of the background task points at (SDK 57's
 * `NotificationTaskPayload`): a tap on Android (`actionIdentifier`, the
 * notification inside), or a received push — its `data`, whose values
 * `expo-notifications` may also hand over as one JSON string `dataString`,
 * and on iOS the APNs payload, where our data is at the top and under `body`
 * (`apns-push-provider.ts` writes both). `null` — not one of ours.
 */
export function notificationIdOfTask(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if ("actionIdentifier" in record) {
    const content = (record.notification as { request?: { content?: { data?: unknown } } } | null)
      ?.request?.content;
    return pushMessageOf(content?.data).notificationId;
  }
  const data = (record.data ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = [data];
  if (typeof data.dataString === "string") {
    try {
      candidates.push(JSON.parse(data.dataString));
    } catch {
      // Not JSON: nothing of ours in it.
    }
  }
  if (data.body && typeof data.body === "object") candidates.push(data.body);
  if (record.aps || record.body) candidates.push(record, record.body);
  for (const candidate of candidates) {
    const id = pushMessageOf(candidate).notificationId;
    if (id) return id;
  }
  return null;
}

export interface BackgroundAckDeps {
  /** Waits until the session is read from the secure storage; `true` — signed in. */
  signedIn: () => Promise<boolean>;
  /** The confirmation itself (through the app's API client: one token exchange, `SESSION_ENDED`). */
  ack: (notificationId: string) => Promise<void>;
  /** Leaves it for the next start or return of the app; awaited — the write must land. */
  later: (notificationId: string) => void | Promise<void>;
}

export type BackgroundAckResult = "acked" | "not_ours" | "signed_out" | "dropped" | "later";

/**
 * The background task (TASK-056 requirement 4): a push that arrived while the
 * app was closed or in the background is confirmed from there, so the
 * WhatsApp copy (4.80) does not go for a push that reached the phone. Every
 * failure is silent; a confirmation that could not be sent waits for the app.
 */
export async function runBackgroundAck(
  payload: unknown,
  deps: BackgroundAckDeps,
): Promise<BackgroundAckResult> {
  const notificationId = notificationIdOfTask(payload);
  if (!notificationId) return "not_ours";
  if (!(await deps.signedIn())) return "signed_out";
  let failure: unknown;
  try {
    await deps.ack(notificationId);
  } catch (error) {
    failure = error ?? new Error("ack failed");
  }
  const outcome = ackOutcomeOf(failure);
  if (outcome === "retry") {
    // Written before the task ends: the system may stop the app right after it.
    await deps.later(notificationId);
    return "later";
  }
  return outcome === "done" ? "acked" : "dropped";
}
