import { randomBytes, randomInt } from "node:crypto";
import { ORDER_CODE_LENGTH, ORDER_QR_PREFIX } from "@adclub/contracts";

/**
 * The confirmation code and the QR of an order (PRODUCT 10.1; SCREENS
 * M-ORD-03, M-ORD-04, S-SCAN; ARCHITECTURE 4.31).
 *
 * The code is six digits: a user says it on the phone or at the counter
 * («482 915») and an employee types it on any keypad — digits are the one
 * alphabet with no look-alike and no language to spell it in. It is drawn
 * from a cryptographic source; the database keeps it unique among active
 * orders (`customer_order_active_code_key`) and the order draws again on a
 * clash. The QR carries 128 random bits of its own, unique for ever.
 *
 * Both are kept in the order as they are — the user must see them again —
 * and leave the server only in the user's own answers: never in the
 * supplier's or the administrator's, never in a log line, an error, the
 * order's journal or the action journal.
 */

export function newConfirmationCode(): string {
  return String(randomInt(0, 10 ** ORDER_CODE_LENGTH)).padStart(ORDER_CODE_LENGTH, "0");
}

export function newQrToken(): string {
  return randomBytes(16).toString("base64url");
}

/** What the app draws as the QR of the order. */
export function qrPayload(token: string): string {
  return `${ORDER_QR_PREFIX}${token}`;
}

/** What the customer showed at the counter, as the server looks it up. */
export type OrderCredentialRef =
  | { kind: "code"; code: string }
  | { kind: "qr"; token: string }
  /** Six digits were expected and something else came. */
  | { kind: "not_a_code" }
  /** The scanned string is not the QR of a club order at all. */
  | { kind: "not_our_qr" };

const CODE = new RegExp(`^\\d{${String(ORDER_CODE_LENGTH)}}$`);
/** The token as `newQrToken` writes it: 128 bits in base64url. */
const QR_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Reads what the employee sent (TASK-022): the digits typed on the keypad,
 * with or without the spaces the customer sees them in and with or without
 * the dashes some people put in, or the content of a scanned QR. Nothing
 * of the input is ever put into an answer, a log line or an error.
 */
export function readCredential(input: { code?: string; qr?: string }): OrderCredentialRef {
  if (typeof input.qr === "string") {
    if (!input.qr.startsWith(ORDER_QR_PREFIX)) {
      return { kind: "not_our_qr" };
    }
    const token = input.qr.slice(ORDER_QR_PREFIX.length).trim();
    return QR_TOKEN.test(token) ? { kind: "qr", token } : { kind: "not_our_qr" };
  }
  const digits = (input.code ?? "").replace(/[\s\u00a0.\-_]/g, "");
  return CODE.test(digits) ? { kind: "code", code: digits } : { kind: "not_a_code" };
}
