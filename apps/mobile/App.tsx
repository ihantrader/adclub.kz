import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  ThemeProvider,
  themeModeStore,
  ToastProvider,
  useAppFonts,
  useTheme,
} from "./src/design-system";
import { AppStart } from "./src/start/AppStart";
import { CityProvider } from "./src/state/city-provider";
import { GarageProvider } from "./src/state/garage-provider";
import { LanguageProvider } from "./src/state/language";
import { readyWithin } from "./src/state/device-store";
import { devicePreferencesReady } from "./src/state/stores";

// The splash (graphite, logo) stays until fonts and the stored preferences
// are ready, so the first frame already has Onest, the chosen theme, the
// chosen language and the chosen city.
void SplashScreen.preventAutoHideAsync();

/** Stored preferences, bounded: a stuck storage must not keep the splash forever. */
const preferencesReady = Promise.all([
  readyWithin(themeModeStore.ready, 1000),
  devicePreferencesReady,
]).then(() => undefined);

function Root() {
  const { theme } = useTheme();
  return (
    <>
      <AppStart />
      <StatusBar style={theme.name === "dark" ? "light" : "dark"} />
    </>
  );
}

export default function App() {
  const [fontsLoaded, fontError] = useAppFonts();
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  // A failed font load falls back to the system font (it covers Kazakh too).
  const ready = preferencesLoaded && (fontsLoaded || fontError !== null);

  useEffect(() => {
    void preferencesReady.then(() => setPreferencesLoaded(true));
  }, []);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <LanguageProvider>
          <CityProvider>
            <GarageProvider>
              <ToastProvider>
                <Root />
              </ToastProvider>
            </GarageProvider>
          </CityProvider>
        </LanguageProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
