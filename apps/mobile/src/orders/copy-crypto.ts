import { gcm } from "@noble/ciphers/aes";

/**
 * Encryption of the saved copy of active orders (TASK-030 requirement 6,
 * ARCHITECTURE 3.6.2 variant A): the copy holds the codes and the QR of
 * every active order, so it never lies in the ordinary storage of the
 * device in the clear. AES-256-GCM: the key — 32 random bytes kept in the
 * platform's secure storage (Keychain / Keystore); the copy itself — this
 * sealed text in `AsyncStorage`, which has no limit on a value the way the
 * secure storage has (about 2 KB).
 *
 * `@noble/ciphers` — an audited implementation in plain TypeScript: the
 * same code runs on the phone (Hermes has no WebCrypto), in the browser
 * and in the tests, and nothing about it needs a native module. Random
 * bytes come from the caller (`expo-crypto` in the app), so tests decide
 * them.
 *
 * GCM authenticates what it decrypts: a copy changed by one bit, cut short,
 * sealed with another key or not sealed at all opens as `null` — never as
 * something half-read.
 */

export const COPY_KEY_BYTES = 32;
const NONCE_BYTES = 12;
/** Binds the sealed text to what it is: a copy of orders, this format. */
const ASSOCIATED_DATA = utf8Encode("adclub.orders-copy.v1");

export type RandomBytes = (count: number) => Uint8Array;

/** A fresh key, as the text the secure storage keeps. */
export function newCopyKey(random: RandomBytes): string {
  return base64Encode(random(COPY_KEY_BYTES));
}

/** The key the secure storage gave back; `null` — not a key of this format. */
export function readCopyKey(text: string | null): Uint8Array | null {
  if (text === null) return null;
  const bytes = base64Decode(text);
  return bytes && bytes.length === COPY_KEY_BYTES ? bytes : null;
}

export function sealCopy(key: Uint8Array, plaintext: string, random: RandomBytes): string {
  const nonce = random(NONCE_BYTES);
  const sealed = gcm(key, nonce, ASSOCIATED_DATA).encrypt(utf8Encode(plaintext));
  return JSON.stringify({ v: 1, n: base64Encode(nonce), c: base64Encode(sealed) });
}

/** The plaintext, or `null` for anything that is not a copy sealed with this key. */
export function openCopy(key: Uint8Array, sealed: string): string | null {
  try {
    const envelope: unknown = JSON.parse(sealed);
    if (typeof envelope !== "object" || envelope === null) return null;
    const { v, n, c } = envelope as Record<string, unknown>;
    if (v !== 1 || typeof n !== "string" || typeof c !== "string") return null;
    const nonce = base64Decode(n);
    const data = base64Decode(c);
    if (!nonce || nonce.length !== NONCE_BYTES || !data) return null;
    return utf8Decode(gcm(key, nonce, ASSOCIATED_DATA).decrypt(data));
  } catch {
    return null;
  }
}

// ------------------------------------------------- bytes ⇄ text, without the engine

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : ALPHABET[c & 63];
  }
  return out;
}

export function base64Decode(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const values = [0, 1, 2, 3].map((k) => {
      const char = text[i + k]!;
      return char === "=" ? 0 : ALPHABET.indexOf(char);
    });
    const triple = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    if (at < out.length) out[at++] = (triple >> 16) & 255;
    if (at < out.length) out[at++] = (triple >> 8) & 255;
    if (at < out.length) out[at++] = triple & 255;
  }
  return out;
}

/** UTF-8 by hand: `TextDecoder` is not part of every engine the app runs on. */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const a = bytes[i]!;
    let code: number;
    if (a < 0x80) {
      code = a;
      i += 1;
    } else if (a >= 0xf0) {
      code =
        ((a & 7) << 18) |
        ((bytes[i + 1]! & 63) << 12) |
        ((bytes[i + 2]! & 63) << 6) |
        (bytes[i + 3]! & 63);
      i += 4;
    } else if (a >= 0xe0) {
      code = ((a & 15) << 12) | ((bytes[i + 1]! & 63) << 6) | (bytes[i + 2]! & 63);
      i += 3;
    } else {
      code = ((a & 31) << 6) | (bytes[i + 1]! & 63);
      i += 2;
    }
    out += String.fromCodePoint(code);
  }
  return out;
}
