import type { ShowcaseItemQuery, ShowcaseListQuery } from "@adclub/contracts";
import type { GarageCar } from "../garage/garage";

/**
 * How the app tells the server which car the catalog is for (TASK-028
 * requirement 2; ARCHITECTURE 4.29 I290, 4.25).
 *
 * The client **never** decides whether an item fits: it only names the car,
 * and every mark, «уточните параметр» and «Подходит для» comes back from
 * the server's single evaluator. Nothing about the car is stored on the
 * server for a guest — it travels with each request (ARCHITECTURE 8.4).
 *
 * When the chosen levels named exactly one modification, that id is sent on
 * its own: the server derives the generation, the model and the make from
 * it, and sending the same levels again could only disagree with it. The
 * year is sent whenever it is known, because a modification usually spans
 * several years and the records of compatibility are bounded by years.
 */
export type VehicleQuery = Pick<
  ShowcaseListQuery,
  | "vehicleModificationId"
  | "vehicleMakeId"
  | "vehicleModelId"
  | "vehicleGenerationId"
  | "vehicleBodyTypeId"
  | "vehicleEngineId"
  | "vehicleTransmissionTypeId"
  | "vehicleDriveTypeId"
  | "vehicleYear"
>;

export function vehicleQuery(car: GarageCar | null): VehicleQuery {
  if (!car) return {};
  const year = car.year === null ? {} : { vehicleYear: car.year };
  if (car.modificationId) {
    return { vehicleModificationId: car.modificationId, ...year };
  }
  return {
    vehicleMakeId: car.make.id,
    vehicleModelId: car.model.id,
    ...(car.generation ? { vehicleGenerationId: car.generation.id } : {}),
    ...(car.body ? { vehicleBodyTypeId: car.body.id } : {}),
    ...(car.engine ? { vehicleEngineId: car.engine.id } : {}),
    ...(car.transmission ? { vehicleTransmissionTypeId: car.transmission.id } : {}),
    ...(car.drive ? { vehicleDriveTypeId: car.drive.id } : {}),
    ...year,
  };
}

/** The same car in the query of an item's card (M-CAT-07). */
export function vehicleItemQuery(
  car: GarageCar | null,
): Pick<ShowcaseItemQuery, keyof VehicleQuery> {
  return vehicleQuery(car);
}
