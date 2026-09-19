import {
  ATTRIBUTE_TEXT_VALUE_MAX_LENGTH,
  type AttributeValue,
  type CatalogValueRejectionReason,
} from "@adclub/contracts";
import { normalizeText } from "./catalog-texts";
import type { AttributeOptionRow, AttributeRow, ItemAttributeValueRow } from "./schema";

/**
 * Attribute values of items (TASK-011 requirement 3; ARCHITECTURE 4.17):
 * one value in the column of its attribute's type, checked against the
 * attribute — bounds and whole numbers, an active option of that very
 * attribute, a text of limited length. `null` is an empty value: no row.
 */

/** The typed columns of `item_attribute_value`. */
export interface StoredColumns {
  valueNum: string | null;
  valueOptionId: string | null;
  valueBool: boolean | null;
  valueText: string | null;
}

export type ValueCheck =
  | { ok: true; columns: StoredColumns | null; value: AttributeValue }
  | { ok: false; reason: CatalogValueRejectionReason; message: string };

const EMPTY: StoredColumns = {
  valueNum: null,
  valueOptionId: null,
  valueBool: null,
  valueText: null,
};

function refuse(reason: CatalogValueRejectionReason, message: string): ValueCheck {
  return { ok: false, reason, message };
}

/** The value of a stored row as the API gives it. */
export function valueOf(row: ItemAttributeValueRow | undefined): AttributeValue {
  if (!row) {
    return null;
  }
  switch (row.attributeValueType) {
    case "number":
      return row.valueNum === null ? null : Number(row.valueNum);
    case "enum":
      return row.valueOptionId;
    case "bool":
      return row.valueBool;
    case "text":
      return row.valueText;
  }
}

/**
 * Whether two values are one (a number by its value, a text in its stored
 * form): writing a value equal to the stored one changes nothing.
 */
export function sameValue(a: AttributeValue, b: AttributeValue): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return normalizeText(a) === normalizeText(b);
  }
  return a === b;
}

/**
 * Checks a new value of `attribute`; `options` — the attribute's options
 * (every status). An archived attribute takes no new value.
 */
export function checkValue(
  attribute: AttributeRow,
  options: readonly AttributeOptionRow[],
  value: AttributeValue,
): ValueCheck {
  if (attribute.status !== "active") {
    return refuse("attribute_archived", "The attribute is archived and takes no new values");
  }
  if (value === null) {
    return { ok: true, columns: null, value: null };
  }
  switch (attribute.valueType) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return refuse("wrong_type", "A number is expected");
      }
      if (attribute.numberInteger && !Number.isInteger(value)) {
        return refuse("not_integer", "A whole number is expected");
      }
      const min = attribute.numberMin === null ? null : Number(attribute.numberMin);
      const max = attribute.numberMax === null ? null : Number(attribute.numberMax);
      if ((min !== null && value < min) || (max !== null && value > max)) {
        return refuse("out_of_range", `The value must be within ${min ?? "−∞"}…${max ?? "∞"}`);
      }
      return { ok: true, columns: { ...EMPTY, valueNum: String(value) }, value };
    }
    case "enum": {
      if (typeof value !== "string") {
        return refuse("wrong_type", "The id of one of the attribute's options is expected");
      }
      const option = options.find((entry) => entry.id === value);
      if (!option || option.attributeId !== attribute.id || option.status !== "active") {
        return refuse("option_invalid", "Not an active option of this attribute");
      }
      return { ok: true, columns: { ...EMPTY, valueOptionId: option.id }, value: option.id };
    }
    case "bool": {
      if (typeof value !== "boolean") {
        return refuse("wrong_type", "Yes or no (true/false) is expected");
      }
      return { ok: true, columns: { ...EMPTY, valueBool: value }, value };
    }
    case "text": {
      if (typeof value !== "string") {
        return refuse("wrong_type", "A text is expected");
      }
      if (/\p{Cc}/u.test(value.replace(/[\t\n\r]/g, " "))) {
        return refuse("wrong_type", "A text must not contain control characters");
      }
      const text = normalizeText(value);
      if (text === "") {
        return refuse("empty_text", "An empty text is an empty value: send null");
      }
      if (text.length > ATTRIBUTE_TEXT_VALUE_MAX_LENGTH) {
        return refuse(
          "too_long",
          `A text is at most ${ATTRIBUTE_TEXT_VALUE_MAX_LENGTH} characters`,
        );
      }
      return { ok: true, columns: { ...EMPTY, valueText: text }, value: text };
    }
  }
}

/** How the action journal shows a value: an option by its code, the rest as they are. */
export function journalValue(
  value: AttributeValue,
  options: ReadonlyMap<string, AttributeOptionRow>,
): AttributeValue {
  if (typeof value === "string") {
    const option = options.get(value);
    if (option) {
      return option.code;
    }
  }
  return value;
}
