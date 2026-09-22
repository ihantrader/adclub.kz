import type { ShowcaseOfferSupplier, ShowcaseViewer } from "@adclub/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import type { ClubAccess } from "../club-access";
import { supplier, type AuthenticatedSession } from "../identity";
import { supplierLocation } from "../suppliers";

/**
 * Who is looking at the catalog, and what they may see of suppliers
 * (D-005, D-030, D-059; PRODUCT 9; ARCHITECTURE 4.29, 8.4). The one place
 * of the rule for every route of the catalog:
 *
 * - no club access (a guest — `auth_required`; a user without it —
 *   `subscription_required`): the supplier of an offer is `hidden` — the
 *   variant has no name, id, district or address at all, and they are
 *   never even read from the database for such a viewer;
 * - club access (`ClubAccess`, the one function of D-059): the name and id
 *   of the supplier, and the district and address of its pickup point
 *   (D-030). Never the phone or the hours (D-026: after an order is
 *   accepted, EPIC-08).
 */
export interface Viewer {
  accountId: string | null;
  clubAccess: boolean;
}

export async function viewerOf(
  session: AuthenticatedSession | null,
  access: ClubAccess,
): Promise<Viewer> {
  if (!session) {
    return { accountId: null, clubAccess: false };
  }
  return { accountId: session.accountId, clubAccess: await access.has(session.accountId) };
}

export function describeViewer(viewer: Viewer): ShowcaseViewer {
  return { signedIn: viewer.accountId !== null, clubAccess: viewer.clubAccess };
}

/** The supplier of each of these offers (by offer id) as the viewer may see it. */
export async function offerSuppliers(
  executor: DbExecutor,
  viewer: Viewer,
  offers: readonly { id: string; supplierId: string; locationId: string }[],
): Promise<Map<string, ShowcaseOfferSupplier>> {
  const described = new Map<string, ShowcaseOfferSupplier>();
  if (!viewer.clubAccess) {
    const hidden: ShowcaseOfferSupplier = {
      kind: "hidden",
      reason: viewer.accountId === null ? "auth_required" : "subscription_required",
    };
    for (const entry of offers) {
      described.set(entry.id, { ...hidden });
    }
    return described;
  }
  const supplierIds = [...new Set(offers.map((entry) => entry.supplierId))];
  if (supplierIds.length === 0) {
    return described;
  }
  const rows = await executor
    .select({
      supplierId: supplier.id,
      name: supplier.name,
      locationId: supplierLocation.id,
      district: supplierLocation.district,
      address: supplierLocation.address,
    })
    .from(supplier)
    .innerJoin(supplierLocation, eq(supplierLocation.supplierId, supplier.id))
    .where(
      and(
        inArray(supplier.id, supplierIds),
        inArray(
          supplierLocation.id,
          offers.map((entry) => entry.locationId),
        ),
      ),
    );
  const byLocation = new Map(rows.map((row) => [row.locationId, row]));
  for (const entry of offers) {
    const row = byLocation.get(entry.locationId);
    if (!row) {
      continue;
    }
    described.set(entry.id, {
      kind: "visible",
      id: row.supplierId,
      name: row.name,
      district: row.district,
      address: row.address,
    });
  }
  return described;
}
