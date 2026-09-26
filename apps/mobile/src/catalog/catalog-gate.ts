import { primaryCar, type GarageCar, type GarageState } from "../garage/garage";

/**
 * The catalog opens only with a car (D-062, PRODUCT 6.6, SCREENS M-CAT-01):
 * the app is for car owners, so a garage without a car has no goods and no
 * services to show — the catalog tab is one screen, «Добавьте автомобиль».
 *
 * This is the one place that says which of the two it is. Everything after
 * it (`CatalogGate` in the navigation, the catalog screens) works with a car
 * that is certainly there, so no catalog screen has a «no car» branch, and
 * nothing in the app can ask the server for the catalog without one.
 * The server keeps its own rule for a request without a car (the console of
 * an administrator and the checks use it, ARCHITECTURE 4.25); the app never
 * sends one.
 */
export type CatalogEntry =
  /** No car in the garage: the tab shows «Добавьте автомобиль» and nothing else. */
  | { kind: "needs-car" }
  /** The catalog for this car — the main one of the garage. */
  | { kind: "open"; car: GarageCar };

export function catalogEntry(garage: GarageState): CatalogEntry {
  // The garage always names a main car when it has any (`parseGarage`,
  // `addCar` and `removeCar` keep it so); the first car is only a guard for
  // a state that somehow does not, so a garage with cars never shows the
  // «add a car» screen.
  const car = primaryCar(garage) ?? garage.cars[0] ?? null;
  return car ? { kind: "open", car } : { kind: "needs-car" };
}
