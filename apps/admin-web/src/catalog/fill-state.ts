import type {
  AttributeValue,
  CatalogValueRejection,
  CategoryFillCell,
  CategoryFillRow,
} from "@adclub/contracts";
import { sameValue } from "./values";

/**
 * The edits of the fill table (A-CAT-03; TASK-035): every changed cell
 * remembers the value it was read with (`previous`), so the server can tell
 * a colleague's change meanwhile (`conflict`). Saving is all or nothing;
 * a refusal comes back cell by cell and every typed value stays.
 */
export type CellKey = `${string}:${string}`;

export function cellKey(itemId: string, attributeId: string): CellKey {
  return `${itemId}:${attributeId}`;
}

export interface CellEdit {
  itemId: string;
  attributeId: string;
  /** The value as it was read. */
  previous: AttributeValue;
  /** The value typed (already of the attribute's type). */
  value: AttributeValue;
}

export interface CellError {
  message: string;
  /** `conflict`: the value stored now. */
  current?: AttributeValue;
}

/** The value a row holds for an attribute. */
export function rowValue(row: CategoryFillRow, attributeId: string): AttributeValue {
  return row.values.find((entry) => entry.attributeId === attributeId)?.value ?? null;
}

/** Puts an edit, or takes it away when the value is back to what was read. */
export function withEdit(
  edits: ReadonlyMap<CellKey, CellEdit>,
  edit: CellEdit,
): Map<CellKey, CellEdit> {
  const next = new Map(edits);
  const key = cellKey(edit.itemId, edit.attributeId);
  if (sameValue(edit.previous, edit.value)) next.delete(key);
  else next.set(key, edit);
  return next;
}

/** The cells of `PUT …/fill`, in a stable order. */
export function fillCells(edits: ReadonlyMap<CellKey, CellEdit>): CategoryFillCell[] {
  return [...edits.values()].map((edit) => ({
    itemId: edit.itemId,
    attributeId: edit.attributeId,
    previous: edit.previous,
    value: edit.value,
  }));
}

const REASONS: Record<CatalogValueRejection["reason"], string> = {
  conflict: "Значение уже изменили",
  item_not_found: "Позиции нет в этой категории",
  attribute_not_found: "Характеристики нет в категории",
  attribute_archived: "Характеристика в архиве",
  wrong_type: "Значение другого типа",
  option_invalid: "Такого варианта нет",
  out_of_range: "Вне допустимых пределов",
  not_integer: "Нужно целое число",
  too_long: "Слишком длинный текст",
  empty_text: "Пустой текст",
  repeated: "Ячейка указана дважды",
  duplicate_item: "Позиция совпадёт с другой",
};

export function rejectionText(rejection: CatalogValueRejection): string {
  return REASONS[rejection.reason] ?? rejection.message;
}

/**
 * The refusals of a save, at their cells. `index` is the position of the
 * cell in the request, so the cells sent are needed to place them.
 */
export function cellErrors(
  sent: readonly CategoryFillCell[],
  rejections: readonly CatalogValueRejection[],
): Map<CellKey, CellError> {
  const errors = new Map<CellKey, CellError>();
  for (const rejection of rejections) {
    const cell = sent[rejection.index];
    const key = cell
      ? cellKey(cell.itemId, cell.attributeId)
      : cellKey(rejection.itemId, rejection.attributeId);
    errors.set(key, {
      message: rejectionText(rejection),
      ...(rejection.reason === "conflict" ? { current: rejection.currentValue ?? null } : {}),
    });
  }
  return errors;
}
