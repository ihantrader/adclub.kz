import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { ROOT_NAVIGATOR, type RootParams } from "./routes";

/**
 * Opens the sign-in flow (SCREENS M-AUTH-00…03) from anywhere in the app —
 * the same idea as `useCarPicker` (ARCHITECTURE 4.39): the screens are a
 * `push` on the root stack, above whichever tab asked for them, so «назад»
 * and finishing both return to it without jumping to another tab. A press
 * while the flow is already opening does nothing, so it never opens twice.
 *
 * There is no separate "resume the remembered action" step here: since the
 * flow is only ever pushed on top of the screen that asked for it, popping
 * it off (`onDone` in the auth screens) already leaves that same screen on
 * top, in whatever state it was — the "screens" of M-AUTH-00 that name an
 * action to resume (M-CAT-07 «Оформить») arrive with the tasks that build
 * that action (TASK-030).
 */
export function useSignIn() {
  const navigation = useNavigation();
  return useMemo(() => {
    const root = () => navigation.getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR);
    return {
      /** M-AUTH-01, straight away — no shorter path exists once someone asks to sign in. */
      start: () => {
        const nav = root();
        if (!nav) return;
        const routes = nav.getState().routes;
        if (routes[routes.length - 1]?.name === "auth-phone") return;
        nav.push("auth-phone");
      },
      /**
       * M-AUTH-03 for an account that is already signed in but never finished
       * registering (SCREENS M-PRO-01's card for that state): straight to the
       * name and consent, not the phone and the code again.
       */
      resumeRegistration: () => {
        const nav = root();
        if (!nav) return;
        const routes = nav.getState().routes;
        if (routes[routes.length - 1]?.name === "auth-register") return;
        nav.push("auth-register");
      },
    };
  }, [navigation]);
}

/**
 * Leaves the sign-in flow for the screen that opened it (TASK-030): only the
 * screens of the flow go, so a checkout that sent a person to finish the
 * registration (`REGISTRATION_INCOMPLETE`) is still there when they are done,
 * with what they had entered — not every screen above the tabs.
 */
export function leaveAuthFlow(navigation: {
  getState: () => { routes: readonly { name: string }[] };
  pop: (count?: number) => void;
  popToTop: () => void;
}): void {
  const routes = navigation.getState().routes;
  const first = routes.findIndex((route) => route.name.startsWith("auth-"));
  if (first <= 0) navigation.popToTop();
  else navigation.pop(routes.length - first);
}
