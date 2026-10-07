import type { Setting, SettingActor, SettingUnit } from "@adclub/contracts";

/**
 * The rules of A-SET-01 and A-SET-02 without the DOM (TASK-034 requirement
 * 4): which field a setting takes, how its value reads, and the check of a
 * typed value before it is sent — the same type, range, length and form the
 * server's registry describes (`constraints`). The server checks again and
 * has the last word; this only spares a round trip and says why at once.
 */

/** The field a setting is edited with. */
export type Editor =
  "integer" | "number" | "boolean" | "enum" | "text" | "localized" | "json" | "version";

export interface LocalizedInput {
  kk: string;
  ru: string;
  en: string;
}

/** What the field holds while it is edited. */
export type SettingInput = string | boolean | LocalizedInput;

export type ParsedInput = { ok: true; value: unknown } | { ok: false; error: string };

export function editorOf(setting: Setting): Editor {
  switch (setting.type) {
    case "integer":
    case "duration":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "enum":
      return "enum";
    case "localized_text":
      return "localized";
    case "composite":
      return "json";
    case "app_version":
      return "version";
    default:
      return "text";
  }
}

const UNITS: Record<SettingUnit, string> = {
  seconds: "с",
  minutes: "мин",
  hours: "ч",
  days: "дн.",
  count: "",
  usd: "$",
  ratio: "",
  percent: "%",
  hour_of_day: "ч (время Алматы)",
  megabytes: "МБ",
  rows: "строк",
  kzt: "₸",
};

/** «ч», «мин», «$»… — empty for a plain count or a ratio. */
export function unitText(unit: SettingUnit | null): string {
  return unit ? UNITS[unit] : "";
}

function numberText(value: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 6 });
}

function isLocalized(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How a value reads in the list and in «было → стало». */
export function formatValue(setting: Setting, value: unknown): string {
  if (value === null || value === undefined) return "—";
  switch (editorOf(setting)) {
    case "boolean":
      return value === true ? "Да" : "Нет";
    case "integer":
    case "number": {
      if (typeof value !== "number") return JSON.stringify(value);
      const unit = unitText(setting.unit);
      if (setting.unit === "usd") return `$${numberText(value)}`;
      return unit ? `${numberText(value)} ${unit}` : numberText(value);
    }
    case "localized":
      return isLocalized(value) && typeof value.ru === "string" ? value.ru : JSON.stringify(value);
    case "json":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** «от 1 до 48 ч» — the range of a number, `null` when it has none. */
export function rangeText(setting: Setting): string | null {
  const { min, max, minLength, maxLength } = setting.constraints;
  const unit = unitText(setting.unit);
  const tail = unit ? ` ${unit}` : "";
  if (min !== undefined && max !== undefined) {
    return `от ${numberText(min)} до ${numberText(max)}${tail}`;
  }
  if (min !== undefined) return `не меньше ${numberText(min)}${tail}`;
  if (max !== undefined) return `не больше ${numberText(max)}${tail}`;
  if (maxLength !== undefined)
    return `до ${maxLength} знаков${minLength ? `, не меньше ${minLength}` : ""}`;
  if (setting.constraints.maxVersion) {
    return `не выше ${setting.constraints.maxVersion} (текущая версия админки)`;
  }
  return null;
}

/** The field's starting content: the value in effect. */
export function inputOf(setting: Setting, value: unknown = setting.value): SettingInput {
  switch (editorOf(setting)) {
    case "boolean":
      return value === true;
    case "localized": {
      const text = isLocalized(value) ? value : {};
      const pick = (lang: string) => (typeof text[lang] === "string" ? (text[lang] as string) : "");
      return { kk: pick("kk"), ru: pick("ru"), en: pick("en") };
    }
    case "json":
      return JSON.stringify(value, null, 2);
    default:
      return value === null || value === undefined ? "" : String(value);
  }
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function checkRange(setting: Setting, value: number): string | null {
  const { min, max } = setting.constraints;
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    return `Допустимо ${rangeText(setting) ?? ""}`.trim();
  }
  return null;
}

/** The typed value as the server takes it, or why it can't be sent. */
export function parseInput(setting: Setting, input: SettingInput): ParsedInput {
  const editor = editorOf(setting);
  const { constraints } = setting;
  switch (editor) {
    case "boolean":
      return { ok: true, value: input === true };
    case "integer":
    case "number": {
      const text = String(input).trim().replace(/\s/g, "").replace(",", ".");
      if (text === "") return { ok: false, error: "Введите число" };
      const value = Number(text);
      if (!Number.isFinite(value)) return { ok: false, error: "Введите число" };
      if (editor === "integer" && !Number.isInteger(value)) {
        return { ok: false, error: "Введите целое число" };
      }
      const outOfRange = checkRange(setting, value);
      return outOfRange ? { ok: false, error: outOfRange } : { ok: true, value };
    }
    case "enum": {
      const value = String(input);
      return constraints.allowedValues && !constraints.allowedValues.includes(value)
        ? { ok: false, error: "Выберите одно из значений" }
        : { ok: true, value };
    }
    case "version": {
      const value = String(input).trim();
      if (!VERSION.test(value)) return { ok: false, error: "Версия — три числа: 1.4.0" };
      if (constraints.maxVersion && compareVersions(value, constraints.maxVersion) > 0) {
        return {
          ok: false,
          error: `Нельзя установить минимальную версию админки выше текущей версии (${constraints.maxVersion})`,
        };
      }
      return { ok: true, value };
    }
    case "localized": {
      const text = input as LocalizedInput;
      const languages = constraints.languages ?? ["kk", "ru", "en"];
      const value: Record<string, string> = {};
      for (const lang of languages) {
        const typed = (text[lang as keyof LocalizedInput] ?? "").trim();
        if (!typed) return { ok: false, error: `Заполните текст на всех языках: ${lang}` };
        if (constraints.maxLength !== undefined && typed.length > constraints.maxLength) {
          return { ok: false, error: `Не длиннее ${constraints.maxLength} знаков (${lang})` };
        }
        value[lang] = typed;
      }
      return { ok: true, value };
    }
    case "json": {
      try {
        return { ok: true, value: JSON.parse(String(input)) as unknown };
      } catch {
        return { ok: false, error: "Это не JSON: проверьте скобки, кавычки и запятые" };
      }
    }
    default: {
      const value = String(input).trim();
      if (constraints.minLength !== undefined && value.length < constraints.minLength) {
        return { ok: false, error: `Не короче ${constraints.minLength} знаков` };
      }
      if (constraints.maxLength !== undefined && value.length > constraints.maxLength) {
        return { ok: false, error: `Не длиннее ${constraints.maxLength} знаков` };
      }
      if (constraints.pattern && !new RegExp(constraints.pattern, "u").test(value)) {
        return { ok: false, error: "Значение не подходит по форме" };
      }
      return { ok: true, value };
    }
  }
}

/** Two values are the same setting value (key order of an object aside). */
export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isLocalized(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A reason is required (SCREENS 7.0): 3–500 characters, not counting spaces at the ends. */
export function reasonProblem(reason: string): string | null {
  const text = reason.trim();
  if (text.length < 3) return "Укажите причину — не короче трёх знаков";
  if (text.length > 500) return "Причина — не длиннее 500 знаков";
  return null;
}

/** Who changed a setting: the number partly hidden, or the server's operator. */
export function settingActorText(actor: SettingActor): string {
  return actor.kind === "operator" ? "оператор сервера" : (actor.phoneMasked ?? "администратор");
}

/**
 * The sign-in security settings (D-053) and anything else only the
 * operator command changes: shown read-only with the note.
 */
export function readOnly(setting: Setting): boolean {
  return setting.editableBy !== "admin";
}

/** The settings of A-SET-02, by platform: the minimum versions and the update text. */
export const CLIENT_POLICY_KEYS = {
  ios: "client_min_version_ios",
  android: "client_min_version_android",
  supplierWeb: "client_min_version_supplier_web",
  adminWeb: "client_min_version_admin_web",
  message: "client_update_message",
} as const;

export const CLIENT_POLICY_LABELS: Record<string, string> = {
  client_min_version_ios: "Приложение iOS",
  client_min_version_android: "Приложение Android",
  client_min_version_supplier_web: "Кабинет поставщика",
  client_min_version_admin_web: "Админка",
  client_update_message: "Текст «Нужно обновить»",
};

/** The groups of A-SET-01: everything but the client policy, which has its own page. */
export function isClientPolicy(key: string): boolean {
  return Object.values(CLIENT_POLICY_KEYS).includes(key as never);
}
