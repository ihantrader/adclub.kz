import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
} from "node:crypto";

/**
 * Keys and one-way forms for the admin second factor. Two keys are
 * derived from `ADMIN_TOTP_ENCRYPTION_KEY`: one encrypts TOTP secrets
 * (AES-256-GCM), the other keys the backup code hashes — so a leaked
 * database alone yields neither a usable secret nor a usable code.
 */
export interface AdminKeys {
  encryption: Buffer;
  backupCodes: Buffer;
}

export function deriveAdminKeys(keyMaterial: string): AdminKeys {
  const derive = (purpose: string) =>
    createHash("sha256").update(`adclub:${purpose}:`).update(keyMaterial).digest();
  return { encryption: derive("totp-secret"), backupCodes: derive("backup-code") };
}

const SECRET_BOX_PREFIX = "v1";
const IV_BYTES = 12;
/** The full GCM tag: a shorter one is never accepted (it would be easier to forge). */
const AUTH_TAG_BYTES = 16;

/**
 * Encrypts a secret bound to `context` (the id of the row that holds it),
 * so a ciphertext copied to another row doesn't decrypt.
 */
export function sealSecret(key: Buffer, context: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    SECRET_BOX_PREFIX,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openSecret(key: Buffer, context: string, sealed: string): string {
  const [prefix, iv, tag, ciphertext] = sealed.split(".");
  if (prefix !== SECRET_BOX_PREFIX || !iv || !tag || ciphertext === undefined) {
    throw new Error("Unsupported sealed secret format");
  }
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== AUTH_TAG_BYTES) {
    throw new Error("Malformed sealed secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, ivBytes, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// No 0/O, 1/I/L: codes are read off paper and typed in.
const BACKUP_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const BACKUP_CODE_LENGTH = 8;

/** A backup code as shown: `xxxx-xxxx` (≈ 39 bits). */
export function generateBackupCode(): string {
  let code = "";
  for (let index = 0; index < BACKUP_CODE_LENGTH; index++) {
    code += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What the administrator typed, in the form codes are hashed in; `null` if it can't be one. */
export function normalizeBackupCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toLowerCase();
  if (code.length !== BACKUP_CODE_LENGTH) {
    return null;
  }
  for (const char of code) {
    if (!BACKUP_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return code;
}

/** Keyed, bound to the administrator: the same code of two admins hashes differently. */
export function hashBackupCode(key: Buffer, adminUserId: string, normalized: string): string {
  return createHmac("sha256", key).update(`${adminUserId}:${normalized}`).digest("base64url");
}
