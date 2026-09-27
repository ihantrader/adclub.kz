import { NavigationContainer, type Theme as NavigationTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo, useState } from "react";
import { useTheme } from "../design-system";
import { EMPTY_DRAFT } from "../garage/car-picker";
import { FirstRunCarScreen } from "../screens/FirstRunCarScreen";
import { FirstRunCityScreen } from "../screens/FirstRunCityScreen";
import { CarStepScreen } from "../screens/garage/CarStepScreen";
import { CarSummaryScreen } from "../screens/garage/CarSummaryScreen";
import type { RootStart } from "../start/root-start";
import { firstRunStore } from "../state/stores";
import { MainTabs } from "./MainTabs";
import { ROOT_NAVIGATOR, type RootParams } from "./routes";
import { useStackScreenOptions } from "./use-stack-screen-options";

const Stack = createNativeStackNavigator<RootParams>();

/**
 * The root of the app after the gates (splash, update, language): one native
 * stack that holds the first run, the tabs and the steps of choosing a car
 * (ARCHITECTURE 4.39). Everything the person moves between — city → car →
 * the steps → the catalog — is a transition of the platform under the one
 * rule of motion, not a screen swapped for another by a state switch; and the
 * steps open above the tabs, so they serve the first run, the catalog and the
 * garage alike.
 *
 * `start` says where it opens and is read once: from then on the screens move
 * themselves, and a later answer of the start decision (the first run
 * finishing) must not rebuild the stack under the person.
 */
export function RootNavigator({ start }: { start: RootStart }) {
  const { theme } = useTheme();
  const screenOptions = useStackScreenOptions();
  const [initial] = useState(start);

  // The navigator's own theme only keeps the colours behind screens right:
  // the visible chrome is the design system's.
  const navigationTheme = useMemo<NavigationTheme>(
    () => ({
      dark: theme.name === "dark",
      colors: {
        primary: theme.colors.accent,
        background: theme.colors.bg,
        card: theme.colors.bar,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.danger,
      },
      fonts: DEFAULT_FONTS,
    }),
    [theme],
  );

  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator
        id={ROOT_NAVIGATOR}
        initialRouteName={initial.screen}
        screenOptions={screenOptions}
      >
        {/* Nothing to go back to from the first screen of the run, and none of it after it. */}
        <Stack.Screen
          name="first-run-city"
          component={FirstRunCityRoute}
          options={{ gestureEnabled: false }}
        />
        <Stack.Screen
          name="first-run-car"
          component={FirstRunCarRoute}
          options={{ gestureEnabled: false, animationTypeForReplace: "push" }}
        />
        <Stack.Screen
          name="tabs"
          component={MainTabs}
          initialParams={initial.screen === "tabs" ? { screen: initial.tab } : undefined}
          options={{ gestureEnabled: false, animationTypeForReplace: "push" }}
        />
        <Stack.Screen name="car-step" component={CarStepScreen} />
        <Stack.Screen name="car-summary" component={CarSummaryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

/** M-START-04. The city is chosen once; the next step replaces this one, so «назад» never returns to it. */
function FirstRunCityRoute({ navigation }: NativeStackScreenProps<RootParams, "first-run-city">) {
  return (
    <FirstRunCityScreen
      onDone={() => {
        firstRunStore.set({ completed: false, step: "car" });
        navigation.replace("first-run-car");
      }}
    />
  );
}

/** M-START-05. Only the list is available (photo and voice are stage D), so the button goes to the first step. */
function FirstRunCarRoute({ navigation }: NativeStackScreenProps<RootParams, "first-run-car">) {
  return (
    <FirstRunCarScreen
      onChooseFromList={() => {
        if (!navigation.isFocused()) return;
        navigation.push("car-step", { origin: "first-run", draft: EMPTY_DRAFT });
      }}
    />
  );
}

/**
 * React Navigation asks for font styles for its own headers and titles;
 * the app draws none of them (`headerShown: false`, own tab bar), so the
 * platform defaults are enough here — screen text uses `Text` of the design
 * system with Onest.
 */
const DEFAULT_FONTS: NavigationTheme["fonts"] = {
  regular: { fontFamily: "System", fontWeight: "400" },
  medium: { fontFamily: "System", fontWeight: "500" },
  bold: { fontFamily: "System", fontWeight: "700" },
  heavy: { fontFamily: "System", fontWeight: "700" },
};
