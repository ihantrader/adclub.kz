import { boolean, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { ormTables } from "../orm-tables";
import { canonicalType, compareSchemas, describeOrmTables, type ColumnShape } from "./schema-drift";

const widget = pgTable("widget", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 32 }).notNull(),
  count: integer("count"),
  active: boolean("active").notNull().default(true),
  seenAt: timestamp("seen_at", { withTimezone: true }),
  localAt: timestamp("local_at"),
});

/** What migrations would have produced for `widget`, as PostgreSQL reports it. */
const migratedWidget: ColumnShape[] = [
  { table: "widget", column: "id", type: "uuid", notNull: true },
  { table: "widget", column: "name", type: "character varying(32)", notNull: true },
  { table: "widget", column: "count", type: "integer", notNull: false },
  { table: "widget", column: "active", type: "boolean", notNull: true },
  { table: "widget", column: "seen_at", type: "timestamp with time zone", notNull: false },
  { table: "widget", column: "local_at", type: "timestamp without time zone", notNull: false },
];

const orm = describeOrmTables([widget]);

describe("canonicalType", () => {
  it.each([
    ["varchar(32)", "character varying(32)"],
    ["character varying(32)", "character varying(32)"],
    ["timestamp", "timestamp without time zone"],
    ["timestamp (3) with time zone", "timestamp(3) with time zone"],
    ["timestamp(3) with time zone", "timestamp(3) with time zone"],
    ["timestamptz", "timestamp with time zone"],
    ["numeric(12, 2)", "numeric(12,2)"],
    ["serial", "integer"],
    ["text[]", "text[]"],
    ["double precision", "double precision"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalType(input)).toBe(expected);
  });
});

describe("compareSchemas", () => {
  it("accepts an ORM description that matches the database", () => {
    expect(compareSchemas(orm, migratedWidget)).toEqual([]);
  });

  it("reports a table missing in the database and one missing in the ORM", () => {
    const other: ColumnShape = { table: "gadget", column: "id", type: "uuid", notNull: true };
    expect(compareSchemas(orm, [other])).toEqual([
      "table gadget: exists in the database but is not described in the ORM",
      "table widget: described in the ORM but missing in the database",
    ]);
  });

  it("reports missing and extra columns", () => {
    const database = [
      ...migratedWidget.filter((column) => column.column !== "count"),
      { table: "widget", column: "color", type: "text", notNull: false },
    ];
    expect(compareSchemas(orm, database)).toEqual([
      "column widget.color: exists in the database but is not described in the ORM",
      "column widget.count: described in the ORM but missing in the database",
    ]);
  });

  it("reports a different type and a different nullability", () => {
    const database = migratedWidget.map((column) =>
      column.column === "count"
        ? { ...column, type: "bigint" }
        : column.column === "seen_at"
          ? { ...column, notNull: true }
          : column,
    );
    expect(compareSchemas(orm, database)).toEqual([
      "column widget.count: type is integer in the ORM but bigint in the database",
      "column widget.seen_at: nullable in the ORM but NOT NULL in the database",
    ]);
  });

  it("notices a varchar length change", () => {
    const database = migratedWidget.map((column) =>
      column.column === "name" ? { ...column, type: "character varying(64)" } : column,
    );
    expect(compareSchemas(orm, database)).toEqual([
      "column widget.name: type is character varying(32) in the ORM but character varying(64) in the database",
    ]);
  });
});

describe("ormTables", () => {
  it("describes every application table with a canonical type", () => {
    const described = describeOrmTables(ormTables);
    expect(new Set(described.map((column) => column.table))).toEqual(
      new Set([
        "account",
        "otp_challenge",
        "phone_verification",
        "session",
        "supplier",
        "supplier_member",
        "admin_user",
        "admin_backup_code",
        "sign_in_step",
        "app_setting",
        "app_setting_change",
        "audit_log",
        "periodic_job_state",
        "category",
        "attribute",
        "attribute_option",
        "translation",
        "brand",
        "brand_spelling",
        "catalog_item",
        "item_attribute_value",
        "item_analog",
      ]),
    );
    expect(described.find((column) => column.column === "expires_at")?.type).toBe(
      "timestamp with time zone",
    );
    expect(
      described.find(
        (column) => column.table === "phone_verification" && column.column === "phone",
      ),
    ).toMatchObject({ type: "text", notNull: true });
  });
});
