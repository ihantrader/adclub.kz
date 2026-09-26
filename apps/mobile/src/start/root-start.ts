import type { TabName } from "../navigation/routes";
import type { StartScreen } from "./start-decision";

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
  { screen: "first-run-city" } | { screen: "first-run-car" } | { screen: "tabs"; tab: TabName };

export function rootStart(screen: StartScreen): RootStart | null {
  switch (screen) {
    case "first-run-city":
      return { screen: "first-run-city" };
    case "first-run-car":
      return { screen: "first-run-car" };
    case "orders-offline":
      return { screen: "tabs", tab: "orders" };
    // The screen a push points at — TASK-031 maps it; the catalog until then.
    case "push":
    case "catalog":
      return { screen: "tabs", tab: "catalog" };
    default:
      return null;
  }
}
