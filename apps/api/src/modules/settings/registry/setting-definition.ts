import type { SettingConstraints, SettingEditableBy, SettingUnit } from "@adclub/contracts";
import { compareAppVersions, isValidAppVersion, parseAppVersion } from "@adclub/domain";
import { languages, type Lang } from "@adclub/i18n";
import { z } from "zod";

/**
 * How one setting is described in the registry (ARCHITECTURE 14, 4.11):
 * type, unit, allowed values, default, description and who may change
 * it. The registry is code; the values are data.
 */
interface DefinitionBase {
  group: string;
  /** What the setting does (Russian, shown in the admin panel). */
  description: string;
  /** `operator`: sign-in security settings, only the operator command changes them (D-053). */
  editableBy: SettingEditableBy;
}

export type DurationUnit = Extract<SettingUnit, "seconds" | "minutes" | "hours" | "days">;

export interface IntegerDefinition extends DefinitionBase {
  type: "integer";
  unit: Exclude<SettingUnit, DurationUnit>;
  min: number;
  max: number;
  default: number;
}

export interface DurationDefinition extends DefinitionBase {
  type: "duration";
  unit: DurationUnit;
  min: number;
  max: number;
  default: number;
}

export interface NumberDefinition extends DefinitionBase {
  type: "number";
  unit: Exclude<SettingUnit, DurationUnit>;
  min: number;
  max: number;
  default: number;
}

export interface BooleanDefinition extends DefinitionBase {
  type: "boolean";
  default: boolean;
}

export interface StringDefinition extends DefinitionBase {
  type: "string";
  maxLength: number;
  default: string;
}

export interface EnumDefinition<Value extends string = string> extends DefinitionBase {
  type: "enum";
  values: readonly [Value, ...Value[]];
  default: Value;
}

export interface LocalizedTextDefinition extends DefinitionBase {
  type: "localized_text";
  maxLength: number;
  default: Record<Lang, string>;
}

export interface CompositeDefinition<Value = unknown> extends DefinitionBase {
  type: "composite";
  /** Strict: unknown fields are refused, missing ones too. */
  schema: z.ZodType<Value>;
  default: Value;
}

export interface AppVersionDefinition extends DefinitionBase {
  type: "app_version";
  /**
   * `admin_web_release`: never above the admin panel version this
   * deployment serves (SCREENS A-SET-02) — the admin panel can't lock
   * itself out.
   */
  maxVersion?: "admin_web_release";
  default: string;
}

export type SettingDefinition =
  | IntegerDefinition
  | DurationDefinition
  | NumberDefinition
  | BooleanDefinition
  | StringDefinition
  | EnumDefinition
  | LocalizedTextDefinition
  | CompositeDefinition
  | AppVersionDefinition;

type Omitted = "type" | "group" | "editableBy";

/** Builders: one per type, so every value type is inferred from the builder. */
export const define = {
  integer:
    (d: Omit<IntegerDefinition, Omitted>) => (group: string, editableBy: SettingEditableBy) =>
      ({ ...d, type: "integer", group, editableBy }) satisfies IntegerDefinition,
  duration:
    (d: Omit<DurationDefinition, Omitted>) => (group: string, editableBy: SettingEditableBy) =>
      ({ ...d, type: "duration", group, editableBy }) satisfies DurationDefinition,
  number: (d: Omit<NumberDefinition, Omitted>) => (group: string, editableBy: SettingEditableBy) =>
    ({ ...d, type: "number", group, editableBy }) satisfies NumberDefinition,
  boolean:
    (d: Omit<BooleanDefinition, Omitted>) => (group: string, editableBy: SettingEditableBy) =>
      ({ ...d, type: "boolean", group, editableBy }) satisfies BooleanDefinition,
  string: (d: Omit<StringDefinition, Omitted>) => (group: string, editableBy: SettingEditableBy) =>
    ({ ...d, type: "string", group, editableBy }) satisfies StringDefinition,
  enum:
    <const Value extends string>(d: Omit<EnumDefinition<Value>, Omitted>) =>
    (group: string, editableBy: SettingEditableBy) =>
      ({ ...d, type: "enum", group, editableBy }) satisfies EnumDefinition<Value>,
  localizedText:
    (d: Omit<LocalizedTextDefinition, Omitted>) => (group: string, editableBy: SettingEditableBy) =>
      ({ ...d, type: "localized_text", group, editableBy }) satisfies LocalizedTextDefinition,
  composite:
    <Value>(d: Omit<CompositeDefinition<Value>, Omitted>) =>
    (group: string, editableBy: SettingEditableBy) =>
      ({ ...d, type: "composite", group, editableBy }) satisfies CompositeDefinition<Value>,
  appVersion:
    (d: Omit<AppVersionDefinition, Omitted>) => (group: string, editableBy: SettingEditableBy) =>
      ({ ...d, type: "app_version", group, editableBy }) satisfies AppVersionDefinition,
};

/** What a value check needs to know about this deployment. */
export interface SettingCheckContext {
  /** The admin panel version this deployment serves (`ADMIN_WEB_RELEASE_VERSION`). */
  adminWebReleaseVersion: string;
}

const versionSchema = z.string().refine(isValidAppVersion, {
  message: "Must be a MAJOR.MINOR.PATCH version, e.g. 1.4.0",
});

function schemaFor(definition: SettingDefinition, context: SettingCheckContext): z.ZodType {
  switch (definition.type) {
    case "integer":
    case "duration":
      return z.number().int().min(definition.min).max(definition.max);
    case "number":
      return z.number().min(definition.min).max(definition.max);
    case "boolean":
      return z.boolean();
    case "string":
      return z.string().trim().min(1).max(definition.maxLength);
    case "enum":
      return z.enum(definition.values);
    case "localized_text":
      return z.strictObject(
        Object.fromEntries(
          languages.map((lang) => [lang, z.string().trim().min(1).max(definition.maxLength)]),
        ) as Record<Lang, z.ZodString>,
      );
    case "composite":
      return definition.schema;
    case "app_version":
      if (definition.maxVersion !== "admin_web_release") {
        return versionSchema;
      }
      return versionSchema.refine(
        (value) => {
          const version = parseAppVersion(value);
          const release = parseAppVersion(context.adminWebReleaseVersion);
          // A malformed value is already refused above.
          return version === null || release === null || compareAppVersions(version, release) <= 0;
        },
        {
          message: `Can't be above the current admin panel version ${context.adminWebReleaseVersion}`,
        },
      );
  }
}

export type SettingCheckResult =
  { ok: true; value: unknown } | { ok: false; issues: { path: string; message: string }[] };

/**
 * Checks a value against its definition: type, range or allowed values,
 * required fields — the same check for a change and for a stored value
 * being read back. Returns the normalized value (strings trimmed).
 */
export function checkSettingValue(
  definition: SettingDefinition,
  value: unknown,
  context: SettingCheckContext,
): SettingCheckResult {
  const result = schemaFor(definition, context).safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: ["value", ...issue.path].join("."),
      message: issue.message,
    })),
  };
}

/** The constraints as the API describes them. */
export function describeConstraints(
  definition: SettingDefinition,
  context: SettingCheckContext,
): SettingConstraints {
  switch (definition.type) {
    case "integer":
    case "duration":
    case "number":
      return { min: definition.min, max: definition.max };
    case "boolean":
      return {};
    case "string":
      return { minLength: 1, maxLength: definition.maxLength };
    case "enum":
      return { allowedValues: [...definition.values] };
    case "localized_text":
      return { minLength: 1, maxLength: definition.maxLength, languages: [...languages] };
    case "composite": {
      const { $schema: _dialect, ...schema } = z.toJSONSchema(definition.schema, {
        target: "draft-2020-12",
      }) as Record<string, unknown>;
      return { schema };
    }
    case "app_version":
      return definition.maxVersion === "admin_web_release"
        ? { maxVersion: context.adminWebReleaseVersion }
        : {};
  }
}

export function unitOf(definition: SettingDefinition): SettingUnit | null {
  return "unit" in definition ? definition.unit : null;
}
