import type { NavigatorScreenParams } from "@react-navigation/native";
import type { CarStep } from "../garage/car-picker";

/**
 * The screens of the app and what they take (TASK-028). Stacks live inside
 * the tabs (ARCHITECTURE 4.37 I384): the catalog walks node → subcategory →
 * item, the garage walks list → car → step-by-step choice.
 */

export type CatalogStackParams = {
  /** M-CAT-01. */
  "catalog-home": undefined;
  /** M-CAT-10: the subcategories of a node. */
  "catalog-node": { categoryId: string };
  /** M-CAT-02: the items of a subcategory. */
  "catalog-items": { categoryId: string };
  /** M-CAT-07. */
  "catalog-item": { itemId: string };
};

export type GarageStackParams = {
  /** M-GAR-01. */
  "garage-list": undefined;
  /** M-GAR-06. */
  "garage-car": { carId: string };
  /**
   * M-GAR-03. `carId` — filling in or editing a car of the garage;
   * `step` — the step «Дополнить» asks for.
   */
  "garage-picker": { carId?: string; step?: CarStep };
};

export type TabParams = {
  catalog: NavigatorScreenParams<CatalogStackParams> | undefined;
  orders: undefined;
  garage: NavigatorScreenParams<GarageStackParams> | undefined;
  profile: undefined;
};

export type TabName = keyof TabParams;
