import type {
  AccountCar,
  CarDocumentInput,
  CarLevels,
  SaveGarageCarBody,
  TransferGarageBody,
} from "@adclub/contracts";
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

/**
 * A device car as `POST`/`PATCH /garage/cars` take it: the levels, the exact
 * modification the levels named (TASK-029.B — it used to be lost on the way
 * to the account, and the catalog then matched by levels only) and the colour.
 */
export function toSaveBody(car: GarageCar): SaveGarageCarBody {
  const document = documentInput(car);
  return {
    levels: toWireLevels(car),
    modificationId: car.modificationId,
    color: car.color,
    vin: car.vin,
    plate: car.plate,
    ...(document ? { document } : {}),
  };
}

/**
 * The mark as the server takes it (TASK-057): «документ показан» only with
 * the proof the recognition signed — a mark the device merely remembers
 * (the account's own copy) is not sent; «не подтверждён» as it is.
 */
export function documentInput(car: GarageCar): CarDocumentInput | null {
  if (car.document?.status === "shown" && car.document.proof) {
    return { status: "shown", proof: car.document.proof };
  }
  if (car.document?.status === "unconfirmed") return { status: "unconfirmed" };
  return null;
}

/**
 * The guest garage as `POST /garage/transfer` takes it (TASK-029
 * requirement 5): every car with its modification and colour; the guest's
 * own main car marked, which the account keeps only when it has none yet.
 */
export function toTransferBody(guest: GarageState): TransferGarageBody {
  return {
    cars: guest.cars.map((car) => ({
      ...toSaveBody(car),
      isPrimary: car.id === guest.primaryId,
    })),
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
    vin: car.vin,
    plate: car.plate,
    document: car.document,
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
