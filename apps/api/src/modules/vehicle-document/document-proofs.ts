import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config";

/**
 * «Документ показан» as something a client can't just claim (D-064,
 * TASK-057): when a registration certificate was read, the recognition
 * answers with a proof the server signed, and a car is marked `shown` only
 * when it is saved with a proof that checks out — the moment of the mark is
 * the one inside the proof, not the client's clock.
 *
 *     vd1.<issued, Unix seconds>.<nonce>.<signature>
 *
 * The proof is not tied to a VIN or a car: the person may correct what was
 * read before saving, and a guest saves the car on the device and moves it
 * into the account days later. It does not expire for the same reason. It
 * only says «a certificate was read at this moment», which is all the mark
 * says. The key is derived from `SESSION_TOKEN_SECRET` with its own label
 * (as the buttons of messages, `ButtonPayloads`), so no new secret is
 * needed and a proof can never stand in for a token or a button.
 */

const PREFIX = "vd1";
const SIGNATURE_BYTES = 16;
const PROOF = /^vd1\.(\d{1,12})\.([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9_-]{16,64})$/;

@Injectable()
export class DocumentProofs {
  private readonly key: Buffer;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(
      hkdfSync("sha256", config.session.tokenSecret, "adclub", "adclub/vehicle-document/v1", 32),
    );
  }

  issue(at: Date): string {
    const body = `${PREFIX}.${String(Math.floor(at.getTime() / 1000))}.${randomBytes(9).toString("base64url")}`;
    return `${body}.${this.signatureOf(body)}`;
  }

  /** The moment a proof was issued, or `null` for anything the server did not sign. */
  read(proof: string, now: Date = new Date()): Date | null {
    const match = PROOF.exec(proof);
    if (!match) return null;
    const body = proof.slice(0, proof.lastIndexOf("."));
    const expected = Buffer.from(this.signatureOf(body));
    const given = Buffer.from(match[3]!);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    const at = new Date(Number(match[1]) * 1000);
    // A proof from the future was not made by this server's clock.
    return at.getTime() > now.getTime() + 5 * 60_000 ? null : at;
  }

  private signatureOf(body: string): string {
    return createHmac("sha256", this.key)
      .update(body)
      .digest()
      .subarray(0, SIGNATURE_BYTES)
      .toString("base64url");
  }
}
