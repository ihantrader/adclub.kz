import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { runEnvironment } from "../config/environment";
import { apiClient } from "../services/api";
import { PENDING_ACKS_KEY, pendingAcksStore, sessionStore } from "../state/stores";
import { runBackgroundAck, withPendingAck } from "./push-ack";

/**
 * The background task of `expo-notifications` (TASK-056 requirement 4,
 * ARCHITECTURE 4.81, I862): a push that reaches the phone while the app is
 * closed or in the background is confirmed from here, so the WhatsApp copy of
 * a critical push (4.80) does not go for one the person already got.
 *
 * - Android: FCM sends data-only messages (`fcm-push-provider.ts`), which
 *   `expo-notifications` draws itself and hands to this task — also when the
 *   app was swiped away (a headless start of the JS).
 * - iOS: APNs pushes carry `content-available: 1` and the build declares
 *   `UIBackgroundModes: remote-notification`; iOS wakes the app when it
 *   decides to — not in Low Power Mode, not after the person swiped the app
 *   away, rarely on a low battery. Then the confirmation comes at the next
 *   opening and the copy may go by its timeout — the accepted limit (9.3).
 *
 * Defined at the top level of the bundle (`index.ts`), before the app's root
 * component, as the task manager requires. Only in an own build: Expo Go and
 * the browser have no such task.
 */
export const BACKGROUND_ACK_TASK = "adclub-push-ack";

type TaskManagerModule = typeof import("expo-task-manager");
type NotificationsModule = typeof import("expo-notifications");

export function defineBackgroundAckTask(): void {
  if (runEnvironment !== "own-build" || (Platform.OS !== "ios" && Platform.OS !== "android")) {
    return;
  }
  let taskManager: TaskManagerModule;
  let notifications: NotificationsModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    taskManager = require("expo-task-manager") as TaskManagerModule;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    notifications = require("expo-notifications") as NotificationsModule;
  } catch {
    return;
  }
  taskManager.defineTask(BACKGROUND_ACK_TASK, async ({ data, error }) => {
    if (!error) {
      await runBackgroundAck(data, {
        signedIn: async () => {
          await sessionStore.ready;
          return sessionStore.get().status === "signed_in";
        },
        ack: async (notificationId) => {
          await apiClient.ackNotification({ notificationId });
        },
        later: async (notificationId) => {
          await pendingAcksStore.ready;
          const next = withPendingAck(pendingAcksStore.get(), notificationId);
          pendingAcksStore.set(next);
          // The store writes in the background; the task waits for the write
          // itself — iOS suspends the app, Android ends the headless run, once
          // the task returns.
          await AsyncStorage.setItem(PENDING_ACKS_KEY, JSON.stringify(next)).catch(() => undefined);
        },
      }).catch(() => undefined);
    }
    return notifications.BackgroundNotificationTaskResult.NewData;
  });
  void notifications.registerTaskAsync(BACKGROUND_ACK_TASK).catch(() => undefined);
}
