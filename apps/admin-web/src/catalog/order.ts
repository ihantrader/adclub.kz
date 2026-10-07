import type {
  CategoryKind,
  ReorderAttributeOptionsBody,
  ReorderAttributesBody,
  ReorderCategoriesBody,
} from "@adclub/contracts";

/**
 * A new order of siblings and the order it was made from (TASK-035;
 * ARCHITECTURE 4.15 I151): the admin panel always sends what it read as
 * `expectedOrder`, so a colleague's reorder meanwhile comes back as a
 * conflict instead of being overwritten silently.
 */
export interface OrderMove {
  ids: string[];
  expectedOrder: string[];
}

/** Moves one sibling a step up (`-1`) or down (`1`); `null` — it is at the edge already. */
export function moveInOrder(order: readonly string[], index: number, by: -1 | 1): OrderMove | null {
  const target = index + by;
  if (index < 0 || index >= order.length || target < 0 || target >= order.length) return null;
  const ids = [...order];
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  return { ids, expectedOrder: [...order] };
}

/** `PUT /admin/catalog/categories/order` for the siblings as shown. */
export function categoryOrderBody(
  parentId: string | null,
  kind: CategoryKind,
  siblings: readonly { id: string }[],
  index: number,
  by: -1 | 1,
): ReorderCategoriesBody | null {
  const move = moveInOrder(
    siblings.map((entry) => entry.id),
    index,
    by,
  );
  return move ? { parentId, kind, categoryIds: move.ids, expectedOrder: move.expectedOrder } : null;
}

/** `PUT /admin/catalog/categories/{id}/attributes/order` for the attributes as shown. */
export function attributeOrderBody(
  attributes: readonly { id: string }[],
  index: number,
  by: -1 | 1,
): ReorderAttributesBody | null {
  const move = moveInOrder(
    attributes.map((entry) => entry.id),
    index,
    by,
  );
  return move ? { attributeIds: move.ids, expectedOrder: move.expectedOrder } : null;
}

/** `PUT /admin/catalog/attributes/{id}/options/order` for the options as shown. */
export function optionOrderBody(
  options: readonly { id: string }[],
  index: number,
  by: -1 | 1,
): ReorderAttributeOptionsBody | null {
  const move = moveInOrder(
    options.map((entry) => entry.id),
    index,
    by,
  );
  return move ? { optionIds: move.ids, expectedOrder: move.expectedOrder } : null;
}
