import { Linking, Platform } from "react-native";
import { pushMessageOf, type PushPermission } from "./push-logic";
import { NO_PUSH, orderOnScreen, type DevicePushToken, type PushPort } from "./push-port";

/**
 * `expo-notifications` behind the port (TASK-051). Loaded only here and only
 * on a phone: the browser of development and the tests never touch it. In
 * Expo Go there is no FCM token on Android (and none on iOS without a
 * development build): `deviceToken` answers `null`, the app works, the server
 * gets nothing — not an error (TASK-051 requirement 6).
 */

type Notifications = typeof import("expo-notifications");

function load(): Notifications | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-notifications") as Notifications;
  } catch {
    return null;
  }
}

function permissionOf(answer: { status: string; canAskAgain: boolean }): PushPermission {
  const status =
    answer.status === "granted"
      ? "granted"
      : answer.status === "denied"
        ? "denied"
        : "undetermined";
  return { status, canAskAgain: answer.canAskAgain };
}

export function createNativePushPort(): PushPort {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return NO_PUSH;
  const notifications = load();
  if (!notifications) return NO_PUSH;
  const platform = Platform.OS;

  // A push of the order whose screen is open is not drawn over it (the screen
  // refreshes); any other is shown as the system shows it.
  notifications.setNotificationHandler({
    handleNotification: (notification) => {
      const message = pushMessageOf(notification.request.content.data);
      const sameScreen =
        message.target?.screen === "order" &&
        message.target.params?.orderId === orderOnScreen.current;
      return Promise.resolve({
        shouldShowBanner: !sameScreen,
        shouldShowList: true,
        shouldPlaySound: !sameScreen,
        shouldSetBadge: false,
      });
    },
  });
  if (platform === "android") {
    void notifications
      .setNotificationChannelAsync("default", {
        name: "Заявки",
        importance: notifications.AndroidImportance.HIGH,
      })
      .catch(() => undefined);
  }

  return {
    available: true,
    permission: async () => permissionOf(await notifications.getPermissionsAsync()),
    request: async () => permissionOf(await notifications.requestPermissionsAsync()),
    deviceToken: async (): Promise<DevicePushToken | null> => {
      try {
        const token = await notifications.getDevicePushTokenAsync();
        return typeof token.data === "string" && token.data.length >= 16
          ? { platform, token: token.data }
          : null;
      } catch {
        // Expo Go, no Google Play services, no network for the platform: no push here.
        return null;
      }
    },
    onTokenChange: (listener) => {
      const subscription = notifications.addPushTokenListener((token) => {
        if (typeof token.data === "string") listener({ platform, token: token.data });
      });
      return () => subscription.remove();
    },
    onReceived: (listener) => {
      const subscription = notifications.addNotificationReceivedListener((notification) =>
        listener(pushMessageOf(notification.request.content.data)),
      );
      return () => subscription.remove();
    },
    onOpened: (listener) => {
      const subscription = notifications.addNotificationResponseReceivedListener((response) =>
        listener(pushMessageOf(response.notification.request.content.data)),
      );
      return () => subscription.remove();
    },
    initialOpened: async () => {
      try {
        const response = await notifications.getLastNotificationResponseAsync();
        return response ? pushMessageOf(response.notification.request.content.data) : null;
      } catch {
        return null;
      }
    },
    openSettings: () => Linking.openSettings(),
  };
}
