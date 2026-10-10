/**
 * Offers on services (PRODUCT 11; SCREENS S-OFF-04, M-CAT-08; TASK-019;
 * ARCHITECTURE 4.61): the price a client with a car sees, and what a
 * supplier of a type may put on offer. The server decides both — the
 * showcase, the snapshot of an order and the cabinet's preview take these
 * functions and nothing else.
 */

/** What a supplier offers (PRODUCT 12.1): goods, services or both. */
export type SupplierOfferType = "goods" | "services" | "both";

/** The type of a catalog item an offer is put on. */
export type OfferItemType = "part" | "generic" | "service";

/**
 * Whether a supplier of this type may offer an item of this type: «только
 * товары» — no services, «только услуги» — no goods, «товары и услуги» —
 * both. Checked when an offer is put on sale or returned to it; an offer
 * that no longer fits (the type was changed after) stays with the supplier
 * and is off the showcase (`supplier_type_mismatch`).
 */
export function supplierOffers(supplierType: SupplierOfferType, itemType: OfferItemType): boolean {
  if (supplierType === "both") {
    return true;
  }
  return itemType === "service" ? supplierType === "services" : supplierType === "goods";
}

/** A price of a service for one model of the car. */
export interface ModelPrice {
  modelId: string;
  price: number;
  /**
   * The model can be chosen by a client: it and its make are active. A
   * model in the archive keeps its price in the offer, but a client with
   * such a model doesn't see it (TASK-019).
   */
  available: boolean;
}

/**
 * The price of an offer: one for every model (a product's price is always
 * this), or a price per model of the car — a model without a row has no
 * price, and its owner doesn't see the offer.
 */
export type ServicePricing =
  { mode: "single"; price: number } | { mode: "by_model"; prices: readonly ModelPrice[] };

/**
 * The price a client with this car sees, or `null` — no price for it: the
 * offer isn't shown to them. `modelId` — the model of the car; `null` — no
 * model is known (the garage asks for one, so this is a car the server
 * couldn't place): then only one price for all models fits.
 */
export function servicePriceForCar(
  pricing: ServicePricing,
  car: { modelId: string | null } | null,
): number | null {
  if (pricing.mode === "single") {
    return pricing.price;
  }
  const modelId = car?.modelId ?? null;
  if (modelId === null) {
    return null;
  }
  const row = pricing.prices.find((entry) => entry.modelId === modelId);
  return row && row.available ? row.price : null;
}

/** The lowest price of a pricing — «от N ₸» of a list and of the cabinet. */
export function lowestServicePrice(pricing: ServicePricing): number | null {
  if (pricing.mode === "single") {
    return pricing.price;
  }
  return pricing.prices.length === 0 ? null : Math.min(...pricing.prices.map((row) => row.price));
}
