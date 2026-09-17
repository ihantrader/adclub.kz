import { describe, expect, it } from "vitest";
import {
  REDACTED,
  REDACTED_IP,
  SANITIZER_FAILED,
  sanitizeForLog,
  sanitizeForTransport,
  sanitizeText,
  sanitizeValue,
} from "./sanitizer";

/**
 * The sanitizer is the only place personal data is removed (ARCHITECTURE
 * 15.3, 4.13), so it is checked on fixtures of everything it may meet:
 * phone numbers in every shape and inside free text, names, e-mail, IP
 * addresses, codes, tokens, request bodies, nested objects and arrays,
 * error fields, and the bound values of a failed statement.
 */

const PHONE = "+77011234567";
const MASK = "+7***4567";

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("sanitizeText: phone numbers", () => {
  it.each([
    ["+77011234567", "+7***4567"],
    ["+7 701 123 45 67", "+7***4567"],
    ["8 (701) 123-45-67", "+7***4567"],
    ["87011234567", "+7***4567"],
    ["77011234567", "+7***4567"],
    ["+7-701-123-45-67", "+7***4567"],
  ])("masks %s", (input, expected) => {
    expect(sanitizeText(input)).toBe(expected);
  });

  it("masks a number inside free text and keeps the rest", () => {
    expect(sanitizeText(`Login code requested for ${PHONE} over whatsapp`)).toBe(
      `Login code requested for ${MASK} over whatsapp`,
    );
  });

  it("masks every number in a text with several", () => {
    const text = sanitizeText(`from +77011234567 to +77479998877`);
    expect(text).toBe("from +7***4567 to +7***8877");
  });

  it("leaves identifiers, versions and ordinary numbers alone", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(sanitizeText(`session=${uuid} generation=12 durationMs=1234 version=1.4.0`)).toBe(
      `session=${uuid} generation=12 durationMs=1234 version=1.4.0`,
    );
  });
});

describe("sanitizeText: other personal data", () => {
  it("keeps only the domain of an e-mail address", () => {
    expect(sanitizeText("wrote to aigerim.k@example.kz today")).toBe(
      "wrote to ***@example.kz today",
    );
  });

  it("masks IPv4 and IPv6 addresses", () => {
    expect(sanitizeText("client 203.0.113.42 connected")).toBe(`client ${REDACTED_IP} connected`);
    expect(sanitizeText("client 2001:0db8:85a3:0000:0000:8a2e:0370:7334 connected")).toBe(
      `client ${REDACTED_IP} connected`,
    );
  });

  it("removes a login code given by its name", () => {
    expect(sanitizeText("verify failed code=483920 attempts=2")).toBe(
      `verify failed code=${REDACTED} attempts=2`,
    );
  });

  it("removes tokens: access, refresh, sign-in step, bearer and otpauth", () => {
    const access = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl";
    const refresh =
      "rt1.550e8400-e29b-41d4-a716-446655440000.3.QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph";
    const step = "st1.550e8400-e29b-41d4-a716-446655440000.QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph";
    const otpauth = "otpauth://totp/Asia%20Drive%20Club:%2B7***4567?secret=JBSWY3DPEHPK3PXP";
    const text = sanitizeText(
      `access=${access} refresh=${refresh} step=${step} uri=${otpauth} header=Bearer ${access}`,
    );
    for (const secret of [access, refresh, step, "JBSWY3DPEHPK3PXP"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("drops the query string of a URL, keeping the path", () => {
    expect(sanitizeText("GET /admin/audit-log?actorAccountId=1&q=Айгерим 200")).toBe(
      `GET /admin/audit-log?${REDACTED} 200`,
    );
    expect(sanitizeText("called https://api.example.kz/v1/search?phone=+77011234567")).toContain(
      `https://api.example.kz/v1/search?${REDACTED}`,
    );
  });

  it("drops the bound values of a failed statement", () => {
    const text = sanitizeText(
      `Failed query: insert into "account" ("phone") values ($1) params: ["${PHONE}"]`,
    );
    expect(text).not.toContain(PHONE);
    expect(text).toContain("insert into");
  });

  it("cuts a very long string", () => {
    expect(sanitizeText("a".repeat(5000))).toHaveLength(2000 + "…[cut]".length);
  });
});

describe("sanitizeValue: objects, arrays and keys", () => {
  it("masks phone fields and removes names, e-mail, address, body and codes", () => {
    const result = sanitizeValue({
      phone: PHONE,
      contactPhone: "+7 747 999 88 77",
      displayName: "Айгерим",
      name: "Айгерим Касымова",
      email: "a@example.kz",
      address: "Алматы, ул. Абая 10, кв. 5",
      loginCode: "483920",
      body: { phone: PHONE, code: "483920" },
      accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      ip: "203.0.113.42",
      userAgent: "Mozilla/5.0 (iPhone)",
    }) as Record<string, unknown>;

    expect(result.phone).toBe(MASK);
    expect(result.contactPhone).toBe("+7***8877");
    for (const key of [
      "displayName",
      "name",
      "email",
      "address",
      "loginCode",
      "body",
      "accessToken",
      "ip",
      "userAgent",
    ]) {
      expect(result[key], key).toBe(REDACTED);
    }
    expect(json(result)).not.toContain("Айгерим");
    expect(json(result)).not.toContain("483920");
  });

  it("keeps identifiers, technical names and safe counters", () => {
    const value = {
      accountId: "550e8400-e29b-41d4-a716-446655440000",
      requestId: "req-1",
      session_id: "s-1",
      entityId: "login_code_length",
      jobName: "identity.cleanup-sessions",
      tableName: "otp_challenge",
      key: "login_code_ttl_seconds",
      codeLength: 6,
      attemptsRemaining: 2,
      statusCode: 429,
    };
    expect(sanitizeValue(value)).toEqual(value);
  });

  it("goes through nested objects and arrays at any depth", () => {
    const result = sanitizeValue({
      level1: { level2: { level3: [{ phone: PHONE, note: "позвонить Айгерим" }] } },
    });
    expect(json(result)).not.toContain(PHONE);
    expect(json(result)).not.toContain("Айгерим");
    expect(json(result)).toContain(MASK);
  });

  it("masks a number inside any string value, whatever the key", () => {
    expect(sanitizeValue({ reason: `duplicate of ${PHONE}` })).toEqual({
      reason: `duplicate of ${MASK}`,
    });
  });

  it("keeps the shape of an error: name, message, stack and causes", () => {
    const cause = new Error(`account ${PHONE} not found`);
    const error = new Error("Database query failed", { cause });
    error.name = "DatabaseQueryError";
    const result = sanitizeValue(error) as Record<string, unknown>;
    expect(result.name).toBe("DatabaseQueryError");
    expect(result.message).toBe("Database query failed");
    expect(String(result.stack)).toContain("sanitizer.test.ts");
    expect(json(result.cause)).toContain(MASK);
    expect(json(result)).not.toContain(PHONE);
  });

  it("removes the fields a driver attaches to its error", () => {
    const error = Object.assign(new Error("insert failed"), {
      detail: `Key (phone)=(${PHONE}) already exists`,
      params: [PHONE, "483920"],
      table: "account",
    });
    const result = sanitizeValue(error) as Record<string, unknown>;
    expect(result.params).toBe(REDACTED);
    expect(result.table).toBe("account");
    expect(json(result)).not.toContain(PHONE);
    expect(json(result)).not.toContain("483920");
  });

  it("survives cycles, huge arrays and deep nesting", () => {
    const cyclic: Record<string, unknown> = { id: "1" };
    cyclic.self = cyclic;
    expect(json(sanitizeValue(cyclic))).toContain("[circular]");

    const long = Array.from({ length: 120 }, (_, index) => index);
    expect(sanitizeValue(long)).toHaveLength(51);

    let deep: unknown = { phone: PHONE };
    for (let level = 0; level < 20; level += 1) {
      deep = { deep };
    }
    expect(json(sanitizeValue(deep))).toContain("[depth]");
    expect(json(sanitizeValue(deep))).not.toContain(PHONE);
  });

  it("handles values that are not plain data", () => {
    const result = sanitizeValue({
      when: new Date("2026-09-18T10:00:00.000Z"),
      pairs: new Map([["phone", PHONE]]),
      set: new Set(["a"]),
      big: 10n,
      fn: () => undefined,
    }) as Record<string, unknown>;
    expect(result.when).toBe("2026-09-18T10:00:00.000Z");
    expect(result.pairs).toEqual({ phone: MASK });
    expect(result.set).toEqual(["a"]);
    expect(result.big).toBe("10n");
    expect(result.fn).toBe("[function]");
  });
});

describe("a failure inside the sanitizer", () => {
  /** A value whose own accessors throw — the sanitizer must not pass it on. */
  function exploding(): unknown {
    return {
      get boom(): string {
        throw new Error("property access failed");
      },
    };
  }

  it("sends nothing outwards", () => {
    expect(sanitizeForTransport(exploding())).toEqual({ ok: false });
  });

  it("still lets a log line through, without the text", () => {
    const throwing = {
      toString(): string {
        throw new Error("no");
      },
    } as unknown as string;
    expect(sanitizeForLog(throwing)).toBe(SANITIZER_FAILED);
  });

  it("passes a normal value through unharmed", () => {
    expect(sanitizeForTransport({ accountId: "a-1", phone: PHONE })).toEqual({
      ok: true,
      value: { accountId: "a-1", phone: MASK },
    });
    expect(sanitizeForLog(`code sent to ${PHONE}`)).toBe(`code sent to ${MASK}`);
  });
});
