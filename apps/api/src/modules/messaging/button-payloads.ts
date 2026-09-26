import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config";

/**
 * The payload of a quick reply (TASK-025 requirement 2; ARCHITECTURE 9.1:
 * «в payload кладём order_id и действие, подписанные HMAC»). A press comes
 * back from the provider with exactly the payload the message was sent with,
 * so the payload is what tells the server what the press means — and it is
 * signed, so a press can only mean what the server itself once wrote:
 *
 *     <button>:<field>:<field>…:<expires, Unix seconds>:<signature>
 *
 * The fields are the owning module's (an order and the employee the message
 * was addressed to); the signature is HMAC-SHA256 of everything before it,
 * cut to 128 bits and written in base64url. A payload with a wrong
 * signature, a different button, a field changed by a single character or
 * a shape of its own is not read at all; an authentic one past its expiry is
 * read as expired, so the module can tell «forged» from «too old».
 *
 * The key is derived from the server's session secret (`SESSION_TOKEN_SECRET`,
 * required outside development and tests) with its own label, so a button
 * signature and a session token can never stand in for each other, and no
 * new secret has to be managed. Rotating that secret retires the buttons
 * already sent — they are short-lived anyway (`order_button_valid_hours`).
 */

/**
 * The longest payload written. Meta does not publish a limit for the payload
 * of a template's quick reply that we could rely on; a payload of an order
 * and an employee is ~115 characters, and this bound keeps it honest.
 */
export const BUTTON_PAYLOAD_MAX_LENGTH = 128;

const SIGNATURE_BYTES = 16;
const FIELD = /^[A-Za-z0-9-]+$/;
const BUTTON = /^[a-z][a-z0-9_]*$/;

export type ButtonPayloadReading =
  | { ok: true; button: string; fields: string[]; expiresAt: Date }
  | {
      ok: false;
      /**
       * `malformed` — not a payload of ours at all; `bad_signature` — the
       * shape of ours with a signature the server never made; `expired` —
       * authentic, but past its time.
       */
      reason: "malformed" | "bad_signature" | "expired";
    };

@Injectable()
export class ButtonPayloads {
  private readonly key: Buffer;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(
      hkdfSync("sha256", config.session.tokenSecret, "adclub", "adclub/message-button/v1", 32),
    );
  }

  sign(button: string, fields: readonly string[], expiresAt: Date): string {
    if (!BUTTON.test(button) || fields.some((field) => !FIELD.test(field))) {
      throw new Error("A button payload is built of a button name and plain fields");
    }
    const body = [button, ...fields, String(Math.floor(expiresAt.getTime() / 1000))].join(":");
    const payload = `${body}:${this.signatureOf(body)}`;
    if (payload.length > BUTTON_PAYLOAD_MAX_LENGTH) {
      throw new Error(`A button payload is longer than ${String(BUTTON_PAYLOAD_MAX_LENGTH)}`);
    }
    return payload;
  }

  read(payload: string, now: Date): ButtonPayloadReading {
    if (payload.length > BUTTON_PAYLOAD_MAX_LENGTH) {
      return { ok: false, reason: "malformed" };
    }
    const parts = payload.split(":");
    if (parts.length < 4) {
      return { ok: false, reason: "malformed" };
    }
    const signature = parts.at(-1)!;
    const expires = parts.at(-2)!;
    const [button, ...rest] = parts.slice(0, -2);
    const fields = rest;
    if (
      !button ||
      !BUTTON.test(button) ||
      !/^\d{1,12}$/.test(expires) ||
      fields.some((field) => !FIELD.test(field))
    ) {
      return { ok: false, reason: "malformed" };
    }
    const body = parts.slice(0, -1).join(":");
    const expected = Buffer.from(this.signatureOf(body));
    const given = Buffer.from(signature);
    // Compared in constant time; a signature of another length is simply wrong.
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { ok: false, reason: "bad_signature" };
    }
    const expiresAt = new Date(Number(expires) * 1000);
    if (expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, button, fields, expiresAt };
  }

  private signatureOf(body: string): string {
    return createHmac("sha256", this.key)
      .update(body)
      .digest()
      .subarray(0, SIGNATURE_BYTES)
      .toString("base64url");
  }
}
