import type { AdminAttribute, AttributeValue, CatalogTexts } from "@adclub/contracts";

/**
 * Values of characteristics by their type (TASK-035; SCREENS A-CAT-03,
 * A-CAT-05): how a value reads, how it is typed into a cell and what the
 * typed text becomes. The admin panel only shapes the value; the server
 * checks the type, the bounds and the options (ARCHITECTURE 4.17).
 */

/** The Russian text of a field, else any there is. */
export function ruText(texts: CatalogTexts | null | undefined): string {
  return texts?.ru?.text ?? texts?.kk?.text ?? texts?.en?.text ?? "";
}

/** The number as people read it: a comma, no trailing zeros. */
export function numberText(value: number): string {
  return String(value).replace(".", ",");
}

/** A value for reading; `null` — «—». */
export function valueText(attribute: AdminAttribute, value: AttributeValue): string {
  if (value === null) return "—";
  switch (attribute.valueType) {
    case "number": {
      if (typeof value !== "number") return String(value);
      const unit = ruText(attribute.unit);
      return unit ? `${numberText(value)} ${unit}` : numberText(value);
    }
    case "enum": {
      const option = attribute.options.find((entry) => entry.id === value);
      return option ? ruText(option.names) : "вариант не найден";
    }
    case "bool":
      return value === true ? "Да" : value === false ? "Нет" : String(value);
    case "text":
      return String(value);
  }
}

/** The text of a value in an input: an option id for a list, `true`/`false` for yes-no. */
export function valueInput(value: AttributeValue): string {
  if (value === null) return "";
  if (typeof value === "number") return numberText(value);
  return String(value);
}

export type ParsedValue = { value: AttributeValue } | { error: string };

/**
 * What a typed text becomes; an empty one — no value. A number takes a
 * comma or a point; its bounds and wholeness are hinted here and decided
 * by the server.
 */
export function parseValue(attribute: AdminAttribute, raw: string): ParsedValue {
  const text = raw.trim();
  if (text === "") return { value: null };
  switch (attribute.valueType) {
    case "number": {
      const normalized = text.replace(/\s/g, "").replace(",", ".");
      if (!/^-?\d+(\.\d+)?$/.test(normalized)) return { error: "Введите число" };
      const value = Number(normalized);
      const settings = attribute.number;
      if (settings?.integer && !Number.isInteger(value)) return { error: "Нужно целое число" };
      if (settings?.min !== null && settings?.min !== undefined && value < settings.min) {
        return { error: `Не меньше ${numberText(settings.min)}` };
      }
      if (settings?.max !== null && settings?.max !== undefined && value > settings.max) {
        return { error: `Не больше ${numberText(settings.max)}` };
      }
      return { value };
    }
    case "enum":
      return { value: text };
    case "bool":
      if (text === "true") return { value: true };
      if (text === "false") return { value: false };
      return { error: "Выберите «Да» или «Нет»" };
    case "text":
      return { value: text };
  }
}

/** Whether two values are the same value (a cell set back to what it was isn't a change). */
export function sameValue(a: AttributeValue, b: AttributeValue): boolean {
  return a === b;
}

/** The bounds of a number attribute in words, for a hint. */
export function numberHint(attribute: AdminAttribute): string | null {
  const settings = attribute.number;
  if (!settings) return null;
  const parts: string[] = [];
  if (settings.integer) parts.push("целое");
  if (settings.min !== null) parts.push(`от ${numberText(settings.min)}`);
  if (settings.max !== null) parts.push(`до ${numberText(settings.max)}`);
  const unit = ruText(attribute.unit);
  if (unit) parts.push(unit);
  return parts.length > 0 ? parts.join(", ") : null;
}
