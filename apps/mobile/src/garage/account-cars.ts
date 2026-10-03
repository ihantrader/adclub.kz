import type { AccountCar, CarLevels } from "@adclub/contracts";
import type { GarageCar, GarageState } from "./garage";

/**
 * The device's garage and the account's garage are two shapes of one thing
 * (ARCHITECTURE 4.41 I424, mobile 4.38 I397); these are the only places that
 * turn one into the other — pure, so they are tested without the network.
 */

/** The levels of a device car as the transfer sends them. */
export function toWireLevels(car: GarageCar): CarLevels {
  return {
    make: car.make,
    model: car.model,
    year: car.year,
    generation: car.generation,
    body: car.body,
    engine: car.engine,
    transmission: car.transmission,
    drive: car.drive,
  };
}

/** The account's car, as the device's own `GarageCar` shape. */
export function fromAccountCar(car: AccountCar): GarageCar {
  return {
    id: car.id,
    make: car.make,
    model: car.model,
    year: car.year,
    generation: car.generation,
    body: car.body,
    engine: car.engine,
    transmission: car.transmission,
    drive: car.drive,
    modificationId: car.modificationId,
    color: car.color,
    addedAt: car.createdAt,
  };
}

/**
 * The device's garage after the account's garage came back from a transfer.
 * The server lists cars newest first; the device keeps them in the order they
 * were added (`GarageCar.addedAt`, oldest first), so that is the order here —
 * a garage must not turn upside down the first time somebody signs in.
 */
export function garageStateFromAccountCars(cars: readonly AccountCar[]): GarageState {
  const mapped = cars
    .map(fromAccountCar)
    .sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt));
  const primary = cars.find((car) => car.isPrimary);
  return { version: 1, cars: mapped, primaryId: primary?.id ?? mapped[0]?.id ?? null };
}
