import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { lazy, Suspense, useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { language } from "./src/config/environment";
import {
  ThemeProvider,
  themeModeStore,
  ToastProvider,
  useAppFonts,
  useTheme,
} from "./src/design-system";
import { HomeScreen } from "./src/screens/HomeScreen";
import { UpdateRequiredScreen } from "./src/screens/UpdateRequiredScreen";
import { updateGate } from "./src/services/api";
import { shouldShowUpdateScreen, useUpdateGateState } from "./src/update-gate";

// The splash (graphite, logo) stays until fonts and the stored theme are ready,
// so the first frame already has Onest and the chosen theme.
void SplashScreen.preventAutoHideAsync();

// Development builds only (Expo Go): in production `__DEV__` is false and the
// showcase is never loaded or reachable.
const ShowcaseScreen = __DEV__ ? lazy(() => import("./src/dev/ShowcaseScreen")) : null;

/** Stored theme read, bounded: a stuck storage must not keep the splash forever. */
const themeReady = Promise.race([
  themeModeStore.ready,
  new Promise<void>((resolve) => setTimeout(resolve, 1000)),
]);

function Root() {
  const { theme } = useTheme();
  const updateState = useUpdateGateState(updateGate);
  const [showcase, setShowcase] = useState(false);

  useEffect(() => {
    void updateGate.check();
  }, []);

  let screen;
  if (shouldShowUpdateScreen(updateState)) {
    screen = (
      <UpdateRequiredScreen
        lang={language}
        message={updateState.message}
        onCheckAgain={updateGate.check}
      />
    );
  } else if (ShowcaseScreen && showcase) {
    screen = (
      <Suspense fallback={null}>
        <ShowcaseScreen onClose={() => setShowcase(false)} />
      </Suspense>
    );
  } else {
    screen = (
      <HomeScreen
        lang={language}
        onOpenShowcase={ShowcaseScreen ? () => setShowcase(true) : undefined}
      />
    );
  }

  return (
    <>
      {screen}
      <StatusBar style={theme.name === "dark" ? "light" : "dark"} />
    </>
  );
}

export default function App() {
  const [fontsLoaded, fontError] = useAppFonts();
  const [themeLoaded, setThemeLoaded] = useState(false);
  // A failed font load falls back to the system font (it covers Kazakh too).
  const ready = themeLoaded && (fontsLoaded || fontError !== null);

  useEffect(() => {
    void themeReady.then(() => setThemeLoaded(true));
  }, []);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ToastProvider>
          <Root />
        </ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
