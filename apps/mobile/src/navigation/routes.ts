import type { NavigatorScreenParams } from "@react-navigation/native";
import type { CarDraft } from "../garage/car-picker";

/**
 * The screens of the app and what they take (TASK-027, TASK-028, TASK-028.A).
 *
 * One **root stack** holds the first run, the tabs and the steps of choosing
 * a car; the catalog and the garage have stacks of their own inside their
 * tabs (ARCHITECTURE 4.37 I384, 4.39). The steps sit in the root stack, above
 * the tabs, so they open over whichever tab asked for them, «назад» and
 * saving return to it, and the first run uses the very same screens.
 */

export type CatalogStackParams = {
  /** M-CAT-01. */
  "catalog-home": undefined;
  /**
   * M-CAT-10: the subcategories of a node. `title` is the name the previous
   * screen already showed, so the top bar does not read «Каталог» while the
   * screen slides in and the real name arrives with the data.
   */
  "catalog-node": { categoryId: string; title?: string };
  /** M-CAT-02: the items of a subcategory. */
  "catalog-items": { categoryId: string; title?: string };
  /** M-CAT-07. */
  "catalog-item": { itemId: string; title?: string };
};

export type GarageStackParams = {
  /** M-GAR-01. */
  "garage-list": undefined;
  /** M-GAR-06. */
  "garage-car": { carId: string };
};

export type TabParams = {
  catalog: NavigatorScreenParams<CatalogStackParams> | undefined;
  orders: undefined;
  garage: NavigatorScreenParams<GarageStackParams> | undefined;
  profile: undefined;
};

export type TabName = keyof TabParams;

/**
 * One screen of the step-by-step choice of a car (M-GAR-03). A step is a
 * screen of the stack, so the system «назад» — the arrow, the edge swipe,
 * the Android button — returns to the previous step, one at a time.
 *
 * `draft` is what had been decided when this screen opened: plain ids and
 * labels, the whole of its state. The screen asks for the first level the
 * draft lacks, and a step that is asked next is a `push` of the same route
 * with the chosen value added — so going back is just the route underneath.
 */
export interface CarStepParams {
  /** Where the choice began: the first run ends with the car, the app returns where it came from. */
  origin: "first-run" | "app";
  /** A car of the garage being completed or edited. */
  carId?: string;
  draft: CarDraft;
}

export type RootParams = {
  /** M-START-04. */
  "first-run-city": undefined;
  /** M-START-05. */
  "first-run-car": undefined;
  tabs: NavigatorScreenParams<TabParams> | undefined;
  /** M-GAR-03. */
  "car-step": CarStepParams;
};

/** The id of the root navigator: `navigation.getParent(ROOT_NAVIGATOR)` finds it from any screen. */
export const ROOT_NAVIGATOR = "root";
