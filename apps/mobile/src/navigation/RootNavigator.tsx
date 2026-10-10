import { NavigationContainer, type Theme as NavigationTheme } from "@react-navigation/native";
import { fontFamily, typography } from "@adclub/ui-core";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo, useState } from "react";
import { useTheme } from "../design-system";
import { CodeScreen } from "../screens/auth/CodeScreen";
import { PhoneScreen } from "../screens/auth/PhoneScreen";
import { RegisterScreen } from "../screens/auth/RegisterScreen";
import { FirstRunCarScreen } from "../screens/FirstRunCarScreen";
import { FirstRunCityScreen } from "../screens/FirstRunCityScreen";
import { CarDocumentScreen } from "../screens/garage/CarDocumentScreen";
import { CarStepScreen } from "../screens/garage/CarStepScreen";
import { CarSummaryScreen } from "../screens/garage/CarSummaryScreen";
import { CheckoutScreen } from "../screens/orders/CheckoutScreen";
import { OrderQrScreen } from "../screens/orders/OrderQrScreen";
import { OrderScreen } from "../screens/orders/OrderScreen";
import { OrdersScreen } from "../screens/tabs/OrdersScreen";
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
        <Stack.Screen name="car-document" component={CarDocumentScreen} />
        <Stack.Screen name="car-step" component={CarStepScreen} />
        <Stack.Screen name="car-summary" component={CarSummaryScreen} />
        {/* Sign-in (TASK-029, SCREENS M-AUTH-01…03): pushed above whichever tab asked for it (`useSignIn`). */}
        <Stack.Screen name="auth-phone" component={PhoneScreen} />
        <Stack.Screen name="auth-code" component={CodeScreen} />
        {/* No visible back arrow (no `back` prop on its `Screen`) but the
            system "назад" still works — leaving it incomplete is allowed
            (SCREENS M-AUTH-03: a gated action simply returns here later). */}
        <Stack.Screen name="auth-register" component={RegisterScreen} />
        {/* Orders (TASK-030): above the tabs, like the steps and the sign-in. */}
        <Stack.Screen name="order-checkout" component={CheckoutScreen} />
        <Stack.Screen name="order" component={OrderScreen} />
        <Stack.Screen name="order-qr" component={OrderQrScreen} />
        {/* M-START-03 «Показать активные заявки»: the copy, read only (`OrdersReadOnly`). */}
        <Stack.Screen
          name="orders-readonly"
          component={OrdersScreen}
          options={{ gestureEnabled: false }}
        />
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

/** M-START-05: the photo of the certificate first (D-064); the screen opens the rest itself. */
function FirstRunCarRoute(_props: NativeStackScreenProps<RootParams, "first-run-car">) {
  return <FirstRunCarScreen />;
}

/**
 * React Navigation asks for font styles for its own headers and titles;
 * the app draws none of them (`headerShown: false`, own tab bar) — screen
 * text uses `Text` of the design system. Should one ever show, it is Onest
 * without 700, like the rest of the interface (D-068): its "bold" and
 * "heavy" are Medium.
 */
const DEFAULT_FONTS: NavigationTheme["fonts"] = {
  regular: { fontFamily: fontFamily.native[typography.body.fontWeight], fontWeight: "normal" },
  medium: { fontFamily: fontFamily.native[typography.label.fontWeight], fontWeight: "normal" },
  bold: { fontFamily: fontFamily.native[typography.label.fontWeight], fontWeight: "normal" },
  heavy: { fontFamily: fontFamily.native[typography.label.fontWeight], fontWeight: "normal" },
};
