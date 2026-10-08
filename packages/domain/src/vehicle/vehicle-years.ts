/**
 * The years of the vehicle catalog (TASK-035.C, D-071). A year of a
 * generation or a modification is a year of production: the «год выпуска»
 * of a Kazakh registration certificate, never a future one. The current
 * year is the one in Almaty, so the server and the admin panel agree on
 * New Year's night whatever the viewer's clock says.
 */

/** The time zone whose calendar decides «the current year». */
export const VEHICLE_YEAR_TIME_ZONE = "Asia/Almaty";

/** The latest year a generation or a modification may name at `at`. */
export function latestVehicleYear(at: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: VEHICLE_YEAR_TIME_ZONE, year: "numeric" }).format(
      at,
    ),
  );
}
