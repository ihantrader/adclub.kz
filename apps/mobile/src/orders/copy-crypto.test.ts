import { describe, expect, it } from "vitest";
import {
  base64Decode,
  base64Encode,
  newCopyKey,
  openCopy,
  readCopyKey,
  sealCopy,
  utf8Decode,
  utf8Encode,
} from "./copy-crypto";

// Plain Node checks of the encryption of the saved copy (TASK-030, AC-7).

let seed = 1;
const random = (count: number) =>
  Uint8Array.from({ length: count }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % 256;
  });

const TEXT = JSON.stringify({
  code: "482915",
  name: "Алдыңғы тежегіш қалыптары ә ғ қ ң ө ұ ү һ і 🚗",
});

describe("sealing the copy", () => {
  it("opens with its key what it sealed, Kazakh letters and emoji included", () => {
    const key = readCopyKey(newCopyKey(random))!;
    expect(openCopy(key, sealCopy(key, TEXT, random))).toBe(TEXT);
  });

  it("never seals the same text twice the same way (a fresh nonce each time)", () => {
    const key = readCopyKey(newCopyKey(random))!;
    expect(sealCopy(key, TEXT, random)).not.toBe(sealCopy(key, TEXT, random));
  });

  it("does not open with another key, or once changed", () => {
    const key = readCopyKey(newCopyKey(random))!;
    const other = readCopyKey(newCopyKey(random))!;
    const sealed = sealCopy(key, TEXT, random);
    expect(openCopy(other, sealed)).toBeNull();
    const envelope = JSON.parse(sealed) as { v: number; n: string; c: string };
    const bytes = base64Decode(envelope.c)!;
    bytes[0] = bytes[0]! ^ 1;
    expect(openCopy(key, JSON.stringify({ ...envelope, c: base64Encode(bytes) }))).toBeNull();
    expect(openCopy(key, JSON.stringify({ ...envelope, v: 2 }))).toBeNull();
    expect(openCopy(key, "not json")).toBeNull();
    expect(openCopy(key, TEXT)).toBeNull();
  });

  it("keeps a key only of its own length", () => {
    expect(readCopyKey(newCopyKey(random))).toHaveLength(32);
    expect(readCopyKey(base64Encode(new Uint8Array(16)))).toBeNull();
    expect(readCopyKey("@@@")).toBeNull();
    expect(readCopyKey(null)).toBeNull();
  });
});

describe("bytes and text without the engine", () => {
  it("writes base64 exactly as the standard does", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      const encoded = base64Encode(utf8Encode(text));
      expect(encoded).toBe(Buffer.from(text).toString("base64"));
      expect(utf8Decode(base64Decode(encoded)!)).toBe(text);
    }
  });

  it("writes UTF-8 exactly as the standard does", () => {
    expect(Buffer.from(utf8Encode(TEXT)).toString("utf8")).toBe(TEXT);
    expect(utf8Decode(Uint8Array.from(Buffer.from(TEXT, "utf8")))).toBe(TEXT);
  });
});
