import { z } from "zod";

/**
 * Settings (ARCHITECTURE 14, 4.11; SCREENS A-SET-01, A-SET-02): product
 * thresholds, limits, time frames and texts kept in data. Every setting
 * has a default in the server's registry; only changed values are stored.
 * Enum values here are only ever added (ARCHITECTURE 7.4).
 */

/** A setting key: `snake_case`, as in ARCHITECTURE 14. */
export const settingKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, { message: "Must be a snake_case setting key" });

/**
 * - `integer`, `number` — with `constraints.min`/`max` and a `unit`;
 * - `duration` — a whole number of `unit` (seconds, minutes, hours, days);
 * - `boolean`;
 * - `string` — with `constraints.minLength`/`maxLength`;
 * - `enum` — one of `constraints.allowedValues`;
 * - `localized_text` — `{ kk, ru, en }`, none of them empty;
 * - `composite` — an object or list described by `constraints.schema` (JSON Schema);
 * - `app_version` — `MAJOR.MINOR.PATCH`.
 */
export const settingTypeSchema = z.enum([
  "integer",
  "number",
  "duration",
  "boolean",
  "string",
  "enum",
  "localized_text",
  "composite",
  "app_version",
]);

export type SettingType = z.infer<typeof settingTypeSchema>;

export const settingUnitSchema = z.enum([
  "seconds",
  "minutes",
  "hours",
  "days",
  "count",
  "usd",
  "ratio",
  "percent",
  "hour_of_day",
  "megabytes",
  "rows",
  // Tenge (TASK-018: the bounds of an offer's price).
  "kzt",
]);

export type SettingUnit = z.infer<typeof settingUnitSchema>;

/**
 * Who may change a setting: `admin` — an administrator through the API
 * (and the operator command); `operator` — only the server operator
 * command (sign-in security settings, D-053).
 */
export const settingEditableBySchema = z.enum(["admin", "operator"]);

export type SettingEditableBy = z.infer<typeof settingEditableBySchema>;

/** What a value must satisfy; only the fields relevant to the type are present. */
export const settingConstraintsSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  allowedValues: z.array(z.string()).optional(),
  /** `string`: the form a value must have, as a regular expression (TASK-053: model identifiers). */
  pattern: z.string().optional(),
  /** `localized_text`: the languages every value must have. */
  languages: z.array(z.string()).optional(),
  /** `composite`: JSON Schema of the value. */
  schema: z.record(z.string(), z.unknown()).optional(),
  /** `app_version`: the highest version accepted (the admin panel minimum — its current release). */
  maxVersion: z.string().optional(),
  /**
   * `string`: the value names a record of a directory — `city`: an active
   * city of `GET /admin/cities` by its code (TASK-016).
   */
  reference: z.enum(["city"]).optional(),
});

export type SettingConstraints = z.infer<typeof settingConstraintsSchema>;

/** Who made a change. */
export const settingActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("admin"),
    adminId: z.uuid(),
    /** Phone number of the administrator, partly hidden (`+7***4567`). */
    phoneMasked: z.string().nullable(),
  }),
  z.object({ kind: z.literal("operator") }),
]);

export type SettingActor = z.infer<typeof settingActorSchema>;

const jsonValue = z.unknown().refine((value) => value !== undefined, { message: "Required" });

/** One entry of a setting's history (never edited). */
export const settingChangeSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  /** The setting's version this change produced (1, 2, …). */
  version: z.number().int(),
  /** `set` — a new value; `reset` — back to the default. */
  action: z.enum(["set", "reset"]),
  previousValue: jsonValue,
  previousIsDefault: z.boolean(),
  newValue: jsonValue,
  newIsDefault: z.boolean(),
  reason: z.string(),
  by: settingActorSchema,
  at: z.iso.datetime(),
});

export type SettingChange = z.infer<typeof settingChangeSchema>;

export const settingSchema = z.object({
  key: z.string(),
  group: z.string(),
  type: settingTypeSchema,
  unit: settingUnitSchema.nullable(),
  /** What the setting does (Russian). */
  description: z.string(),
  constraints: settingConstraintsSchema,
  defaultValue: jsonValue,
  /** The value in effect. */
  value: jsonValue,
  /** No changed value is in effect (never changed, reset, or the stored one is invalid). */
  isDefault: z.boolean(),
  /**
   * A stored value exists but fails the checks (edited by hand, or the
   * registry changed): the default is in effect instead.
   */
  storedValueInvalid: z.boolean(),
  /** Pass it back as `expectedVersion` when changing; 0 — never changed. */
  version: z.number().int(),
  editableBy: settingEditableBySchema,
  /** The latest change (`null` — never changed). */
  lastChange: z
    .object({
      action: z.enum(["set", "reset"]),
      by: settingActorSchema,
      at: z.iso.datetime(),
    })
    .nullable(),
});

export type Setting = z.infer<typeof settingSchema>;

export const settingGroupSchema = z.object({
  id: z.string(),
  /** Group name (Russian). */
  title: z.string(),
  settings: z.array(settingSchema),
});

export type SettingGroup = z.infer<typeof settingGroupSchema>;

/** `GET /admin/settings`. */
export const settingListResponseSchema = z.object({
  groups: z.array(settingGroupSchema),
});

export type SettingListResponse = z.infer<typeof settingListResponseSchema>;

export const settingKeyPathSchema = z.object({
  key: settingKeySchema,
});

export type SettingKeyPath = z.infer<typeof settingKeyPathSchema>;

const reasonSchema = z.string().trim().min(3).max(500);

/** `PUT /admin/settings/{key}`. */
export const changeSettingBodySchema = z.object({
  value: jsonValue,
  /** `version` of the setting the change was made from; a different current version is a conflict. */
  expectedVersion: z.number().int().min(0),
  /** Why (required, 3–500 characters). */
  reason: reasonSchema,
});

export type ChangeSettingBody = z.infer<typeof changeSettingBodySchema>;

/** `POST /admin/settings/{key}/reset`. */
export const resetSettingBodySchema = z.object({
  expectedVersion: z.number().int().min(0),
  reason: reasonSchema,
});

export type ResetSettingBody = z.infer<typeof resetSettingBodySchema>;

/** A change or a reset: the setting as it is now and the change ("was → now"). */
export const settingChangedResponseSchema = z.object({
  setting: settingSchema,
  change: settingChangeSchema,
});

export type SettingChangedResponse = z.infer<typeof settingChangedResponseSchema>;

/** `GET /admin/settings/{key}/history`: newest first. */
export const settingHistoryResponseSchema = z.object({
  key: z.string(),
  changes: z.array(settingChangeSchema),
});

export type SettingHistoryResponse = z.infer<typeof settingHistoryResponseSchema>;

/** `details` of `SETTING_VERSION_CONFLICT`. */
export const settingVersionConflictDetailsSchema = z.object({
  currentVersion: z.number().int(),
});

export type SettingVersionConflictDetails = z.infer<typeof settingVersionConflictDetailsSchema>;
