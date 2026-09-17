import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { ClientBase, Pool } from "pg";

/** One column as the comparison sees it. */
export interface ColumnShape {
  table: string;
  column: string;
  /** Canonical PostgreSQL type, e.g. `timestamp with time zone`, `character varying(32)`. */
  type: string;
  notNull: boolean;
}

/** Tables that belong to tooling, not to the application schema. */
const TOOLING_TABLES = new Set(["pgmigrations"]);

const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  int4: "integer",
  serial: "integer",
  serial4: "integer",
  int2: "smallint",
  smallserial: "smallint",
  int8: "bigint",
  bigserial: "bigint",
  serial8: "bigint",
  bool: "boolean",
  float4: "real",
  float8: "double precision",
  decimal: "numeric",
  varchar: "character varying",
  char: "character",
};

const ZONED_ALIASES: Record<string, string> = { timestamptz: "timestamp", timetz: "time" };

/**
 * Brings the ways Drizzle and PostgreSQL spell one type to a single form:
 * `varchar(32)` ≡ `character varying(32)`, `timestamp (3) with time zone`
 * ≡ `timestamp(3) with time zone`, `timestamp` ≡ `timestamp without time
 * zone`, `numeric(12, 2)` ≡ `numeric(12,2)`.
 */
export function canonicalType(type: string): string {
  const value = type
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*\)/g, ")");
  const match = /^([a-z0-9_ ]+?)(\([^)]*\))?( with(?:out)? time zone)?((?:\[\])*)$/.exec(value);
  if (!match) {
    return value;
  }
  const [, name = "", params = "", zone = "", array = ""] = match;
  let base = TYPE_ALIASES[name] ?? name;
  let timeZone = zone;
  if (ZONED_ALIASES[name]) {
    base = ZONED_ALIASES[name];
    timeZone = " with time zone";
  }
  if ((base === "timestamp" || base === "time") && !timeZone) {
    timeZone = " without time zone";
  }
  return `${base}${params}${timeZone}${array}`;
}

/** Columns the ORM describes, one entry per column of every table. */
export function describeOrmTables(tables: readonly PgTable[]): ColumnShape[] {
  return tables.flatMap((table) => {
    const config = getTableConfig(table);
    const primaryKeyColumns = new Set(
      config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
    );
    return config.columns.map((column) => ({
      table: config.name,
      column: column.name,
      type: canonicalType(column.getSQLType()),
      // A primary key column is NOT NULL in PostgreSQL whatever the ORM says.
      notNull: column.notNull || column.primary || primaryKeyColumns.has(column.name),
    }));
  });
}

/** Columns of every ordinary table in `schema`, as PostgreSQL reports them. */
export async function readDatabaseColumns(
  db: Pool | ClientBase,
  schema = "public",
): Promise<ColumnShape[]> {
  const { rows } = await db.query<{
    table: string;
    column: string;
    type: string;
    not_null: boolean;
  }>(
    `SELECT c.relname AS table,
            a.attname AS column,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  );
  return rows
    .filter((row) => !TOOLING_TABLES.has(row.table))
    .map((row) => ({
      table: row.table,
      column: row.column,
      type: canonicalType(row.type),
      notNull: row.not_null,
    }));
}

/**
 * Differences between the ORM description and the migrated database:
 * missing or extra tables and columns, a different type, a different
 * nullability. Empty when they agree.
 */
export function compareSchemas(
  orm: readonly ColumnShape[],
  database: readonly ColumnShape[],
): string[] {
  const problems: string[] = [];
  const ormTables = new Set(orm.map((column) => column.table));
  const databaseTables = new Set(database.map((column) => column.table));

  for (const table of ormTables) {
    if (!databaseTables.has(table)) {
      problems.push(`table ${table}: described in the ORM but missing in the database`);
    }
  }
  for (const table of databaseTables) {
    if (!ormTables.has(table)) {
      problems.push(`table ${table}: exists in the database but is not described in the ORM`);
    }
  }

  const key = (column: ColumnShape) => `${column.table}.${column.column}`;
  const databaseColumns = new Map(database.map((column) => [key(column), column]));
  const ormColumns = new Map(orm.map((column) => [key(column), column]));

  for (const [name, ormColumn] of ormColumns) {
    if (!databaseTables.has(ormColumn.table)) {
      continue;
    }
    const databaseColumn = databaseColumns.get(name);
    if (!databaseColumn) {
      problems.push(`column ${name}: described in the ORM but missing in the database`);
      continue;
    }
    if (ormColumn.type !== databaseColumn.type) {
      problems.push(
        `column ${name}: type is ${ormColumn.type} in the ORM but ${databaseColumn.type} in the database`,
      );
    }
    if (ormColumn.notNull !== databaseColumn.notNull) {
      const describe = (notNull: boolean) => (notNull ? "NOT NULL" : "nullable");
      problems.push(
        `column ${name}: ${describe(ormColumn.notNull)} in the ORM but ${describe(databaseColumn.notNull)} in the database`,
      );
    }
  }
  for (const [name, databaseColumn] of databaseColumns) {
    if (ormTables.has(databaseColumn.table) && !ormColumns.has(name)) {
      problems.push(`column ${name}: exists in the database but is not described in the ORM`);
    }
  }
  return problems.sort();
}
