import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle mirrors of the settings tables (`infra/migrations`,
 * `…_create-app-setting.sql` — the source of truth; ARCHITECTURE 5.12, 4.11).
 */

export type SettingActorKind = "admin" | "operator";
export type SettingChangeAction = "set" | "reset";

/** `app_setting`: changed values in effect (a reset deletes the row). */
export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  version: integer("version").notNull(),
  updatedByKind: text("updated_by_kind").$type<SettingActorKind>().notNull(),
  updatedByAdminId: uuid("updated_by_admin_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `app_setting_change`: the append-only history of changes and resets. */
export const appSettingChange = pgTable("app_setting_change", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  action: text("action").$type<SettingChangeAction>().notNull(),
  previousValue: jsonb("previous_value").$type<unknown>().notNull(),
  previousIsDefault: boolean("previous_is_default").notNull(),
  newValue: jsonb("new_value").$type<unknown>().notNull(),
  newIsDefault: boolean("new_is_default").notNull(),
  reason: text("reason").notNull(),
  actorKind: text("actor_kind").$type<SettingActorKind>().notNull(),
  actorAdminId: uuid("actor_admin_id"),
  actorAccountId: uuid("actor_account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settingsTables = [appSetting, appSettingChange];
