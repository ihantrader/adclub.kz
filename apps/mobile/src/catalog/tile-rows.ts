/**
 * The tiles of M-CAT-01 in rows (TASK-030.A): the first node of the data —
 * whatever the administrator put first — takes a row of its own, the rest
 * go two to a row, and a last odd one keeps half the width (`null` holds
 * the other half). A rule of the layout, not a category named in code: the
 * order and the icons of the nodes are the catalog's data.
 */
export function tileRows<T>(nodes: readonly T[]): (T | null)[][] {
  const [first, ...rest] = nodes;
  if (first === undefined) return [];
  const rows: (T | null)[][] = [[first]];
  for (let index = 0; index < rest.length; index += 2) {
    rows.push([rest[index]!, rest[index + 1] ?? null]);
  }
  return rows;
}
