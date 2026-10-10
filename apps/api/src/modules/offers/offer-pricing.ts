import type { OfferModelPrice, OfferPricing } from "@adclub/contracts";
import type { ServicePricing } from "@adclub/domain";
import { inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import type { OfferRow } from "./schema";

/**
 * The prices of offers by model (TASK-019; S-OFF-04; ARCHITECTURE 4.61):
 * the rows of `offer_model_price` with whether a client can choose the
 * model now — it and its make are active. A model in the archive keeps its
 * price in the offer; the domain's `servicePriceForCar` doesn't give it to
 * anyone.
 */

interface ModelPriceRow extends Record<string, unknown> {
  offer_id: string;
  model_id: string;
  make_id: string;
  price: number;
  available: boolean;
  model_name: string | null;
  make_name: string | null;
}

/** Every row of these offers, by offer, ordered by make and model name. */
async function modelPriceRows(
  executor: DbExecutor,
  offerIds: readonly string[],
): Promise<Map<string, ModelPriceRow[]>> {
  const grouped = new Map<string, ModelPriceRow[]>();
  if (offerIds.length === 0) {
    return grouped;
  }
  const rows = await executor.execute<ModelPriceRow>(sql`
    SELECT p.offer_id, p.vehicle_model_id AS model_id, m.make_id, p.price,
      (m.status = 'active' AND mk.status = 'active') AS available,
      (SELECT s.text FROM vehicle_model_spelling s WHERE s.model_id = m.id AND s.is_name LIMIT 1) AS model_name,
      (SELECT s.text FROM vehicle_make_spelling s WHERE s.make_id = m.make_id AND s.is_name LIMIT 1) AS make_name
    FROM offer_model_price p
    JOIN vehicle_model m ON m.id = p.vehicle_model_id
    JOIN vehicle_make mk ON mk.id = m.make_id
    WHERE ${inArray(sql`p.offer_id`, [...offerIds])}
    ORDER BY make_name, model_name, p.vehicle_model_id
  `);
  for (const row of rows.rows) {
    const list = grouped.get(row.offer_id);
    const entry = { ...row, price: Number(row.price) };
    if (list) {
      list.push(entry);
    } else {
      grouped.set(row.offer_id, [entry]);
    }
  }
  return grouped;
}

/** The pricing of each offer as the domain takes it (the showcase, a snapshot). */
export async function servicePricings(
  executor: DbExecutor,
  offers: readonly Pick<OfferRow, "id" | "price" | "priceMode">[],
): Promise<Map<string, ServicePricing>> {
  const byModel = offers.filter((row) => row.priceMode === "by_model");
  const rows = await modelPriceRows(
    executor,
    byModel.map((row) => row.id),
  );
  const pricings = new Map<string, ServicePricing>();
  for (const row of offers) {
    pricings.set(
      row.id,
      row.priceMode === "by_model"
        ? {
            mode: "by_model",
            prices: (rows.get(row.id) ?? []).map((entry) => ({
              modelId: entry.model_id,
              price: entry.price,
              available: entry.available,
            })),
          }
        : { mode: "single", price: row.price },
    );
  }
  return pricings;
}

/** The pricing of each offer as the cabinet and the admin panel show it. */
export async function describePricings(
  executor: DbExecutor,
  offers: readonly Pick<OfferRow, "id" | "priceMode">[],
): Promise<Map<string, OfferPricing>> {
  const rows = await modelPriceRows(
    executor,
    offers.filter((row) => row.priceMode === "by_model").map((row) => row.id),
  );
  const described = new Map<string, OfferPricing>();
  for (const row of offers) {
    described.set(row.id, {
      mode: row.priceMode,
      models: (rows.get(row.id) ?? []).map((entry): OfferModelPrice => ({
        make: { id: entry.make_id, name: entry.make_name ?? "" },
        model: { id: entry.model_id, name: entry.model_name ?? "" },
        price: entry.price,
        available: entry.available,
      })),
    });
  }
  return described;
}

interface ModelStateRow extends Record<string, unknown> {
  id: string;
  available: boolean;
}

/** Whether each of these models exists and a client can choose it now (by id; unknown — absent). */
export async function modelAvailability(
  executor: DbExecutor,
  modelIds: readonly string[],
): Promise<Map<string, boolean>> {
  if (modelIds.length === 0) {
    return new Map();
  }
  const rows = await executor.execute<ModelStateRow>(sql`
    SELECT m.id, (m.status = 'active' AND mk.status = 'active') AS available
    FROM vehicle_model m JOIN vehicle_make mk ON mk.id = m.make_id
    WHERE ${inArray(sql`m.id`, [...new Set(modelIds)])}
    FOR SHARE OF m
  `);
  return new Map(rows.rows.map((row) => [row.id, row.available]));
}
