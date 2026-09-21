import { Injectable } from "@nestjs/common";
import type { OfferSnapshot } from "@adclub/contracts";
import { eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { loadTexts, plainTexts, textsOf } from "../catalog";
import { notFound } from "./offer-errors";
import { offer } from "./schema";

interface SnapshotRow extends Record<string, unknown> {
  supplier_name: string;
  city_id: string;
  city_name: string;
  address: string | null;
  district: string | null;
  time_zone: string;
  article: string | null;
  brand: string | null;
}

/**
 * The snapshot of an offer an order is created with (TASK-018
 * requirement 5; ARCHITECTURE 4.28). Orders (EPIC-08) keep the returned
 * value as it is: it is a copy, so a later price change, a change of the
 * terms or withdrawing the offer never reach it. Taken in the order's
 * transaction, it holds the offer row `FOR SHARE` until the transaction
 * ends — a concurrent change of the offer waits, so the order gets either
 * the terms before it or after it, never a mix.
 */
@Injectable()
export class OfferSnapshots {
  async take(executor: DbExecutor, offerId: string, takenAt: Date): Promise<OfferSnapshot> {
    const [row] = await executor.select().from(offer).where(eq(offer.id, offerId)).for("share");
    if (!row) {
      throw notFound("offer");
    }
    const [facts] = (
      await executor.execute<SnapshotRow>(sql`
        SELECT s.name AS supplier_name, city.id AS city_id, city.name_ru AS city_name,
          l.address, l.district, s.time_zone, i.article,
          (SELECT b.text FROM brand_spelling b WHERE b.brand_id = i.brand_id AND b.is_name) AS brand
        FROM supplier s
        JOIN supplier_location l ON l.id = ${row.locationId}::uuid
        JOIN city ON city.id = l.city_id
        JOIN catalog_item i ON i.id = ${row.itemId}::uuid
        WHERE s.id = ${row.supplierId}::uuid
      `)
    ).rows;
    const names = plainTexts(
      textsOf(await loadTexts(executor, "catalog_item", [row.itemId]), row.itemId, "name"),
    );
    return {
      offerId: row.id,
      offerVersion: row.version,
      takenAt: takenAt.toISOString(),
      supplier: { id: row.supplierId, name: facts!.supplier_name },
      location: {
        id: row.locationId,
        cityId: facts!.city_id,
        cityName: facts!.city_name,
        address: facts!.address,
        district: facts!.district,
        timeZone: facts!.time_zone,
      },
      item: {
        id: row.itemId,
        type: row.itemType,
        names,
        article: facts!.article,
        brand: facts!.brand,
      },
      price: row.price,
      currency: row.currency,
      availability: row.availability,
      leadDays: row.leadDays,
      pickup: row.pickup,
      delivery: row.delivery,
      warrantyMonths: row.warrantyMonths,
      warrantyText: row.warrantyText,
    };
  }
}
