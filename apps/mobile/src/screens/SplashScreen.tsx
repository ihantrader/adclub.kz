import { brandSvg, themes } from "@adclub/ui-core";
import { StyleSheet, View } from "react-native";
import { SvgXml } from "react-native-svg";

const LOGO_WIDTH = 136;
const LOGO_RATIO = 493.5 / 605.08;

/**
 * M-START-01: the logo, and nothing else. The native splash
 * (`expo-splash-screen`) covers the app until the fonts and the stored
 * preferences are read; this one covers the short wait for the client
 * policy — never longer than a few seconds (SCREENS 5.1).
 *
 * It is always graphite with the champagne logo, whatever theme the person
 * chose: the native splash before it is graphite too and cannot follow the
 * theme, so a light-theme phone would otherwise show graphite, then a cream
 * screen for a couple of seconds, then the app — a flash in the middle of the
 * start. The logo has the same size on both, so nothing moves at the hand-over.
 */
export function SplashScreen() {
  return (
    <View style={[styles.container, { backgroundColor: themes.dark.colors.bg }]}>
      <SvgXml
        xml={brandSvg["logo-champagne"]}
        width={LOGO_WIDTH}
        height={LOGO_WIDTH * LOGO_RATIO}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
});
