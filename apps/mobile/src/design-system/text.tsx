import {
  fontFamily,
  fontScale,
  typography,
  type ColorToken,
  type TypographyToken,
} from "@adclub/ui-core";
import { useFonts } from "expo-font";
import {
  StyleSheet,
  Text as NativeText,
  type TextProps as NativeTextProps,
  type TextStyle,
} from "react-native";
import onestLight from "../../assets/fonts/Onest-Light.ttf";
import onestMedium from "../../assets/fonts/Onest-Medium.ttf";
import onestRegular from "../../assets/fonts/Onest-Regular.ttf";
import { useTheme } from "./theme";

/**
 * Onest 300/400/500 bundled with the app (assets/fonts, SIL OFL 1.1; D-068 —
 * no 700). Light is its own registered family, so the phone draws the real
 * thin face instead of a system weight.
 */
export const fontAssets = {
  [fontFamily.native[300]]: onestLight,
  [fontFamily.native[400]]: onestRegular,
  [fontFamily.native[500]]: onestMedium,
};

/** `[loaded, error]`: a failed load falls back to the system font (it covers Kazakh). */
export function useAppFonts(): [boolean, Error | null] {
  return useFonts(fontAssets);
}

/**
 * React Native text styles of DESIGN.md 7.4. Each weight is its own family
 * (Android ignores `fontWeight` for custom fonts); tabular figures use
 * `fontVariant: ["tabular-nums"]`.
 */
export const textStyles = StyleSheet.create(
  Object.fromEntries(
    Object.entries(typography).map(([token, style]) => [
      token,
      {
        fontFamily: fontFamily.native[style.fontWeight],
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        ...(style.tabularNums ? { fontVariant: ["tabular-nums"] } : {}),
      } satisfies TextStyle,
    ]),
  ) as Record<TypographyToken, TextStyle>,
);

export interface TextProps extends NativeTextProps {
  variant?: TypographyToken;
  color?: ColorToken;
}

/** Themed text; wraps by default (DESIGN.md 7.11) and scales with the system font size. */
export function Text({
  variant = "body",
  color = "text",
  style,
  maxFontSizeMultiplier,
  ...rest
}: TextProps) {
  const { theme } = useTheme();
  return (
    <NativeText
      {...rest}
      maxFontSizeMultiplier={
        maxFontSizeMultiplier ?? (variant === "tab" ? fontScale.tabLabelMax : undefined)
      }
      style={[textStyles[variant], { color: theme.colors[color] }, style]}
    />
  );
}
