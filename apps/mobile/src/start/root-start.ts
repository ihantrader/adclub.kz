import type { TabName } from "../navigation/routes";
import type { PushTarget, StartScreen } from "./start-decision";

/**
 * Where the root stack of the app opens (ARCHITECTURE 4.39). The start
 * decision (`decideStart`) says which screen the app opens on; the first run,
 * the tabs and the steps of choosing a car are all screens of one root
 * navigator, so «which screen» is «which route it starts on».
 *
 * `null` for the screens that are not part of it: the splash, the update
 * screen and the language choice are full-screen gates in front of the app,
 * not steps in it.
 */
export type RootStart =
  | { screen: "first-run-city" }
  | { screen: "first-run-car" }
  | { screen: "tabs"; tab: TabName }
  /**
   * M-START-03 «Показать активные заявки» (D-027, TASK-030): the saved copy
   * only, to show a code and a QR — not a decision of `decideStart`, but a
   * press on the update screen, which opens the same navigator on this list.
   */
  | { screen: "orders-readonly" };

export function rootStart(screen: StartScreen, push?: PushTarget | null): RootStart | null {
  switch (screen) {
    case "first-run-city":
      return { screen: "first-run-city" };
    case "first-run-car":
      return { screen: "first-run-car" };
    case "orders-offline":
      return { screen: "tabs", tab: "orders" };
    // Opened from a push (TASK-051): the tab under the screen it points at —
    // «Заявки» under M-ORD-03 (the order itself is opened over it,
    // `openPushTarget`), the profile for the subscription (M-SUB-02 is TASK-041).
    case "push":
      if (push?.screen === "order") return { screen: "tabs", tab: "orders" };
      if (push?.screen === "subscription") return { screen: "tabs", tab: "profile" };
      // A reminder (TASK-069): the catalog's home, its car chosen by `openPushTarget`.
      return { screen: "tabs", tab: "catalog" };
    case "catalog":
      return { screen: "tabs", tab: "catalog" };
    default:
      return null;
  }
}
