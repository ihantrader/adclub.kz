import { brandSvg } from "@adclub/ui-core";
import { StyleSheet, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { useTheme } from "../design-system";

const LOGO_WIDTH = 136;
const LOGO_RATIO = 493.5 / 605.08;

/**
 * M-START-01: the logo, and nothing else. The native splash
 * (`expo-splash-screen`) covers the app until the fonts and the stored
 * preferences are read; this one covers the short wait for the client
 * policy — never longer than a few seconds (SCREENS 5.1).
 */
export function SplashScreen() {
  const { theme } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      <SvgXml
        xml={brandSvg[theme.name === "dark" ? "logo-champagne" : "logo-graphite"]}
        width={LOGO_WIDTH}
        height={LOGO_WIDTH * LOGO_RATIO}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
});
