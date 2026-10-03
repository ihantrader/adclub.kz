import { useFocusEffect } from "@react-navigation/native";
import * as Brightness from "expo-brightness";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { createScreenLight, type ScreenLightDevice } from "../../orders/screen-light";

const KEEP_AWAKE_TAG = "adclub.order-qr";

/**
 * The device side of `createScreenLight` (M-ORD-04): `expo-brightness` for
 * the brightness of the app's own window and `expo-keep-awake` for the
 * screen not going dark. On Android the window brightness ends with the
 * window — closing the screen, sending the app away or the app being killed
 * all return the system's; iOS changes the screen itself, so the value read
 * before is put back. A platform without these (the browser of the dev
 * check) simply leaves things as they are.
 */
const device: ScreenLightDevice = {
  readBrightness: async () => {
    if (!(await Brightness.isAvailableAsync())) return null;
    return Brightness.getBrightnessAsync();
  },
  setBrightness: async (value) => {
    if (await Brightness.isAvailableAsync()) await Brightness.setBrightnessAsync(value);
  },
  restoreBrightness: async (previous) => {
    if (!(await Brightness.isAvailableAsync())) return;
    if (Platform.OS === "android") await Brightness.restoreSystemBrightnessAsync();
    else if (previous !== null) await Brightness.setBrightnessAsync(previous);
  },
  keepAwake: async (on) => {
    if (on) await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    else deactivateKeepAwake(KEEP_AWAKE_TAG);
  },
};

/**
 * Brightness up and no sleep while the screen is on show; everything back
 * the moment it is not: leaving it, the app going to the background (and
 * up again on return), the screen torn down.
 */
export function useScreenLight(): void {
  const [light] = useState(() => createScreenLight(device));

  useFocusEffect(
    useCallback(() => {
      void light.enter();
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") void light.enter();
        else void light.leave();
      });
      return () => {
        subscription.remove();
        void light.leave();
      };
    }, [light]),
  );

  // Torn down without a blur (the whole navigator replaced): back all the same.
  useEffect(() => () => void light.leave(), [light]);
}
