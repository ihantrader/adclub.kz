import type {
  AssistantCar,
  AssistantCarWords,
  CompatibilityVehicle,
  ResolvedCompatibilityVehicle,
} from "@adclub/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import type { DbExecutor } from "../../database";
import { resolveVehicle } from "../compatibility";
import { accountCar, mileageLog } from "../garage";

/**
 * The car of a dialog (D-062: the assistant always works for a car;
 * ARCHITECTURE 11.2): what the catalog filters by (`vehicle`, the levels),
 * and what the model is told — the levels in the words of the vehicle
 * catalog. Nothing else of the person's car goes anywhere: the VIN, the
 * plate and the colour are never read here.
 */
export interface DialogCar {
  vehicle: CompatibilityVehicle;
  resolved: ResolvedCompatibilityVehicle;
  words: AssistantCarWords;
  /** The garage car it came from (a signed-in person's `carId`). */
  carId: string | null;
  /** The car's current mileage, km (the garage's last reading, or what a guest's device sent). */
  mileageKm: number | null;
}

function carRequired(message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, {
    details: [{ path: "car", message }],
  });
}

/** The levels of a garage car, as the catalog takes them. */
function vehicleOfGarageCar(row: typeof accountCar.$inferSelect): CompatibilityVehicle {
  return {
    ...(row.modificationId ? { modificationId: row.modificationId } : {}),
    makeId: row.makeId,
    modelId: row.modelId,
    ...(row.generationId ? { generationId: row.generationId } : {}),
    ...(row.bodyTypeId ? { bodyTypeId: row.bodyTypeId } : {}),
    ...(row.engineId ? { engineId: row.engineId } : {}),
    ...(row.transmissionTypeId ? { transmissionTypeId: row.transmissionTypeId } : {}),
    ...(row.driveTypeId ? { driveTypeId: row.driveTypeId } : {}),
    ...(row.year !== null ? { year: row.year } : {}),
  };
}

/** The car of a message: a garage car of the account, or the levels a guest sent. */
export async function dialogCarOf(
  executor: DbExecutor,
  car: AssistantCar,
  accountId: string | null,
  guestMileageKm: number | undefined,
): Promise<DialogCar> {
  if ("carId" in car) {
    if (!accountId) {
      throw carRequired("A guest sends the car by its levels: a garage car needs a session");
    }
    const [row] = await executor
      .select()
      .from(accountCar)
      .where(and(eq(accountCar.id, car.carId), eq(accountCar.accountId, accountId)));
    if (!row) {
      throw new ApiException(404, "NOT_FOUND", "No such car in the garage");
    }
    const vehicle = vehicleOfGarageCar(row);
    const resolved = await resolveVehicle(executor, vehicle);
    const [reading] = await executor
      .select({ valueKm: mileageLog.valueKm })
      .from(mileageLog)
      .where(eq(mileageLog.carId, row.id))
      .orderBy(desc(mileageLog.recordedAt), desc(mileageLog.createdAt))
      .limit(1);
    return {
      vehicle,
      resolved,
      // The catalog's words only: the garage labels are free text a client sent, unchecked,
      // and must not reach the model's rules (prompt injection, personal data).
      words: await carWordsOf(executor, resolved),
      carId: row.id,
      mileageKm: reading?.valueKm ?? null,
    };
  }
  if (!car.makeId && !car.modificationId) {
    throw carRequired("The assistant works for a car: give at least its make (D-062)");
  }
  const resolved = await resolveVehicle(executor, car);
  return {
    vehicle: car,
    resolved,
    words: await carWordsOf(executor, resolved),
    carId: null,
    mileageKm: guestMileageKm ?? null,
  };
}

/** The levels of a resolved car in the words of the vehicle catalog. */
export async function carWordsOf(
  executor: DbExecutor,
  car: ResolvedCompatibilityVehicle,
): Promise<AssistantCarWords> {
  const result = await executor.execute<{
    make: string | null;
    model: string | null;
    generation: string | null;
    engine: string | null;
    displacement: string | null;
  }>(sql`
    SELECT
      (SELECT text FROM vehicle_make_spelling WHERE make_id = ${car.makeId}::uuid AND is_name LIMIT 1) AS make,
      (SELECT text FROM vehicle_model_spelling WHERE model_id = ${car.modelId}::uuid AND is_name LIMIT 1) AS model,
      (SELECT name FROM vehicle_generation WHERE id = ${car.generationId}::uuid) AS generation,
      (SELECT text FROM vehicle_engine_spelling WHERE engine_id = ${car.engineId}::uuid AND is_code LIMIT 1) AS engine,
      (SELECT displacement_l::text FROM vehicle_engine WHERE id = ${car.engineId}::uuid) AS displacement
  `);
  const row = result.rows[0];
  const engine = row?.engine
    ? row.displacement
      ? `${row.engine} ${String(Number(row.displacement))} л`
      : row.engine
    : null;
  return {
    make: row?.make ?? "",
    model: row?.model ?? null,
    generation: row?.generation ?? null,
    year: car.year,
    engine,
  };
}

/**
 * The engines a car of this model (of its generation, when known) can have
 * — what the assistant offers to choose from when the catalog says
 * «уточните двигатель» (TASK-062 edge case). Active modifications only.
 */
export async function enginesOf(
  executor: DbExecutor,
  car: ResolvedCompatibilityVehicle,
): Promise<{ id: string; name: string }[]> {
  if (!car.modelId) return [];
  const result = await executor.execute<{ id: string; name: string; displacement: string | null }>(
    sql`
      SELECT DISTINCT e.id::text AS id,
             (SELECT text FROM vehicle_engine_spelling s WHERE s.engine_id = e.id AND s.is_code LIMIT 1) AS name,
             e.displacement_l::text AS displacement
      FROM vehicle_modification m
      JOIN vehicle_generation g ON g.id = m.generation_id
      JOIN vehicle_engine e ON e.id = m.engine_id
      WHERE g.model_id = ${car.modelId}::uuid
        AND (${car.generationId}::uuid IS NULL OR m.generation_id = ${car.generationId}::uuid)
        AND m.status = 'active' AND e.status = 'active'
      ORDER BY 2
      LIMIT 12`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.displacement ? `${row.name} ${String(Number(row.displacement))} л` : row.name,
  }));
}
