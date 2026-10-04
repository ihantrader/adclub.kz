import type { CategoryIcon as CategoryIconName } from "@adclub/contracts";
import { uiGlyphs, type ColorToken } from "@adclub/ui-core";
import { categoryGlyphs } from "./category-glyphs";
import { GlyphIcon } from "./Icon";
import { useTheme } from "./theme";

export { categoryGlyphs };

export interface CategoryIconProps {
  /** The icon an administrator gave the category; `null` — the generic one. */
  name: CategoryIconName | null;
  size?: 20 | 24 | 28 | 32 | 40 | 48;
  color?: ColorToken;
}

/**
 * The icon of a catalog category (`categoryIcons` of the contract): the
 * tiles of M-CAT-01 and the placeholder of an item without a photo
 * (DESIGN 7.8). The codes are semantic codes of the data; their glyphs are
 * chosen in design/icons/icons.mjs (`category`) and generated into
 * `category-glyphs.ts`. Decorative — the name of the category is always next to it.
 */
export function CategoryIcon({ name, size = 24, color = "text" }: CategoryIconProps) {
  const { theme } = useTheme();
  return (
    <GlyphIcon
      glyph={name ? categoryGlyphs[name] : uiGlyphs.category}
      size={size}
      color={theme.colors[color]}
    />
  );
}
