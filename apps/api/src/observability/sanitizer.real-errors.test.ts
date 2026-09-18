import { DrizzleQueryError } from "drizzle-orm";
import { DatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import { REDACTED, sanitizeErrorText, sanitizeText, sanitizeValue } from "./sanitizer";

/**
 * TASK-009.A: failures of the database exactly as the driver stack makes
 * them — `DrizzleQueryError` of `drizzle-orm` 0.45 (message
 * `Failed query: <sql>\nparams: a,b,c`, no brackets) wrapping a
 * `DatabaseError` of `pg` with the fields PostgreSQL 16 sent. The field
 * values below were captured from real failed statements on the dev
 * database (unique violations on a name and a phone, a check violation, a
 * value that isn't a uuid); nothing of the bound values or of what
 * PostgreSQL says about them may survive, whatever the path — the object
 * walk (monitoring, log details) or the text of a message and a stack
 * (log lines).
 */

const PHONE_DIGITS = "7011234567";
const PERSONAL = ["Айгерим", "Касымова", "Иван", "Петров", "Абая", PHONE_DIGITS, "not-a-uuid"];

function pgError(message: string, fields: Record<string, string>): DatabaseError {
  const error = new DatabaseError(message, 200, "error");
  return Object.assign(error, { severity: "ERROR", file: "nbtinsert.c", line: "666" }, fields);
}

const QUERY = "insert into zz_capture.t_cap values ($1, $2, $3, $4)";

const fixtures: [string, DrizzleQueryError][] = [
  [
    "unique violation on a name",
    new DrizzleQueryError(
      QUERY,
      [
        "550e8400-e29b-41d4-a716-446655440001",
        "Айгерим Касымова",
        "+77011234568",
        "позвонить +77011234567.",
      ],
      pgError('duplicate key value violates unique constraint "t_cap_display_name_key"', {
        code: "23505",
        detail: "Key (display_name)=(Айгерим Касымова) already exists.",
        schema: "zz_capture",
        table: "t_cap",
        constraint: "t_cap_display_name_key",
        routine: "_bt_check_unique",
      }),
    ),
  ],
  [
    "unique violation on a phone",
    new DrizzleQueryError(
      QUERY,
      ["550e8400-e29b-41d4-a716-446655440002", "Иван Петров", "+77011234567", "y"],
      pgError('duplicate key value violates unique constraint "t_cap_phone_key"', {
        code: "23505",
        detail: "Key (phone)=(+77011234567) already exists.",
        table: "t_cap",
        constraint: "t_cap_phone_key",
      }),
    ),
  ],
  [
    "check violation (the whole row in the detail)",
    new DrizzleQueryError(
      QUERY,
      ["550e8400-e29b-41d4-a716-446655440003", "Иван Петров", "87011234567", "Алматы, ул. Абая 10"],
      pgError('new row for relation "t_cap" violates check constraint "t_cap_phone_check"', {
        code: "23514",
        detail:
          "Failing row contains (550e8400-e29b-41d4-a716-446655440003, Иван Петров, 87011234567, Алматы, ул. Абая 10).",
        constraint: "t_cap_phone_check",
      }),
    ),
  ],
  [
    "a value PostgreSQL quotes in its message",
    new DrizzleQueryError(
      QUERY,
      ["not-a-uuid +77011234567", "Иван", "+7", "y"],
      pgError('invalid input syntax for type uuid: "not-a-uuid +77011234567"', {
        code: "22P02",
        where: "unnamed portal parameter $1 = '...'",
        routine: "string_to_uuid",
      }),
    ),
  ],
];

function expectClean(text: string): void {
  for (const value of PERSONAL) {
    expect(text).not.toContain(value);
  }
}

describe("sanitizer: real database failures (Drizzle + PostgreSQL)", () => {
  it("really has the shape the rules are written for", () => {
    const [, error] = fixtures[0]!;
    // No brackets around the values, the values on the last line of the message.
    expect(error.message).toMatch(/\nparams: 550e8400-[^\n]*,Айгерим Касымова,/);
    expect(error.stack).toContain(error.message);
  });

  it.each(fixtures)("keeps nothing of the data: %s — as an object", (_name, error) => {
    const cleaned = JSON.stringify(sanitizeValue(error));
    expectClean(cleaned);
    // What an investigation needs is still there.
    expect(cleaned).toContain("Failed query: insert into zz_capture.t_cap values ($1, $2, $3, $4)");
    expect(cleaned).toContain(`params=${REDACTED}`);
    expect(cleaned).toMatch(/"code":"(23505|23514|22P02)"/);
    expect(cleaned).toContain("sanitizer.real-errors.test.ts");
  });

  it.each(fixtures)("keeps nothing of the data: %s — as log text", (_name, error) => {
    const { message, stack } = sanitizeErrorText(error);
    expectClean(`${message}\n${stack ?? ""}`);
    expect(stack).toMatch(/\n\s+at /);
    // The cause as the log writes it: its message and its detail as text.
    const cause = error.cause as DatabaseError;
    expectClean(sanitizeText(`${cause.message} ${cause.detail ?? ""} ${cause.where ?? ""}`));
    // The stack as Nest hands it over on its own, as a string.
    expectClean(sanitizeText(error.stack ?? ""));
  });

  it("keeps column and constraint names of a detail", () => {
    expect(sanitizeText("Key (display_name)=(Иван Петров) already exists.")).toBe(
      `Key (display_name)=(${REDACTED}) already exists.`,
    );
    expect(sanitizeText("Key (phone, supplier_id)=(+77011234567, 42) already exists.")).toBe(
      `Key (phone, supplier_id)=(${REDACTED}) already exists.`,
    );
    expect(sanitizeText('invalid input syntax for type uuid: "Айгерим"')).toBe(
      `invalid input syntax for type uuid: "${REDACTED}"`,
    );
  });

  it("drops bound values that span lines and hold commas", () => {
    const error = new DrizzleQueryError(
      "update account set note = $1 where id = $2",
      ["Айгерим Касымова,\n    at позвонить +77011234567", "550e8400-e29b-41d4-a716-446655440000"],
      new Error("connection terminated"),
    );
    const { message, stack } = sanitizeErrorText(error);
    expectClean(`${message}\n${stack ?? ""}`);
  });
});
