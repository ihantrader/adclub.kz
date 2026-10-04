import type { CategoryIcon } from "@adclub/contracts";

interface TreeNode {
  id: string;
  icon: CategoryIcon | null;
  children: readonly { id: string; icon: CategoryIcon | null }[];
}

/**
 * The icon an item without a photo shows (DESIGN 7.8: «заглушка — значок
 * категории», TASK-030.A): the subcategory's own icon, or else the icon of
 * its node — the brake disc for brake pads — and `null` (the generic one)
 * when neither has one or the tree is not loaded. Icons are the catalog's
 * data; the app only looks them up.
 */
export function categoryIconOf(
  nodes: readonly TreeNode[] | undefined,
  subcategoryId: string,
): CategoryIcon | null {
  for (const node of nodes ?? []) {
    if (node.id === subcategoryId) return node.icon;
    const child = node.children.find((candidate) => candidate.id === subcategoryId);
    if (child) return child.icon ?? node.icon;
  }
  return null;
}
