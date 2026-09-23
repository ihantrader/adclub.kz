import { Inject, Injectable } from "@nestjs/common";
import {
  SHOWCASE_ANALOGS_MAX,
  SHOWCASE_KEY_ATTRIBUTES,
  SHOWCASE_PAGE_DEFAULT_SIZE,
  type CatalogLanguage,
  type CompatibilityItemResult,
  type CompatibilityVehicle,
  type LocalizedText,
  type ResolvedCompatibilityVehicle,
  type ShowcaseAnalog,
  type ShowcaseAttributeFilter,
  type ShowcaseAttributeValue,
  type ShowcaseCity,
  type ShowcaseEmptyReason,
  type ShowcaseItemQuery,
  type ShowcaseItemResponse,
  type ShowcaseListItem,
  type ShowcaseListQuery,
  type ShowcaseListResponse,
  type ShowcaseOffer,
} from "@adclub/contracts";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  attribute,
  attributeOption,
  brandSpelling,
  catalogItem,
  CatalogPhotosService,
  category,
  itemAnalog,
  itemAttributeValue,
  loadTexts,
  localize,
  textsOf,
  type AttributeRow,
  type CatalogItemRow,
  type CategoryRow,
} from "../catalog";
import { ClubAccess } from "../club-access";
import {
  CompatibilityEvaluator,
  describeConditions,
  itemCompatibility,
  resolveVehicle,
} from "../compatibility";
import type { AuthenticatedSession } from "../identity";
import { AppSettings } from "../settings";
import { city, localizedCityName } from "../suppliers";
import { offersInReach, visibleOffers, type VisibleOffer } from "./showcase-offers";
import {
  after,
  decodeListCursor,
  encodeListCursor,
  rankFrame,
  rankItems,
  sortOffers,
  summarize,
} from "./showcase-ranking";
import {
  clubOnlyOfferFields,
  describeViewer,
  offerSuppliers,
  viewerOf,
  type Viewer,
} from "./showcase-visibility";

const NO_NAME: LocalizedText = { text: "", isFallback: true };

const YES_NO: Record<CatalogLanguage, [string, string]> = {
  ru: ["Да", "Нет"],
  kk: ["Иә", "Жоқ"],
  en: ["Yes", "No"],
};

function notFound(what: string): ApiException {
  return new ApiException(404, "NOT_FOUND", `No such ${what}`);
}

function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

type VehicleQuery = Pick<
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

/** The car of a query as the compatibility check takes it; `null` — none given. */
function vehicleOf(query: VehicleQuery): CompatibilityVehicle | null {
  const vehicle: CompatibilityVehicle = {
    ...(query.vehicleModificationId && { modificationId: query.vehicleModificationId }),
    ...(query.vehicleMakeId && { makeId: query.vehicleMakeId }),
    ...(query.vehicleModelId && { modelId: query.vehicleModelId }),
    ...(query.vehicleGenerationId && { generationId: query.vehicleGenerationId }),
    ...(query.vehicleBodyTypeId && { bodyTypeId: query.vehicleBodyTypeId }),
    ...(query.vehicleEngineId && { engineId: query.vehicleEngineId }),
    ...(query.vehicleTransmissionTypeId && {
      transmissionTypeId: query.vehicleTransmissionTypeId,
    }),
    ...(query.vehicleDriveTypeId && { driveTypeId: query.vehicleDriveTypeId }),
    ...(query.vehicleYear !== undefined && { year: query.vehicleYear }),
  };
  return Object.keys(vehicle).length === 0 ? null : vehicle;
}

function groupByItem(offers: readonly VisibleOffer[]): Map<string, VisibleOffer[]> {
  const grouped = new Map<string, VisibleOffer[]>();
  for (const entry of offers) {
    const list = grouped.get(entry.itemId);
    if (list) {
      list.push(entry);
    } else {
      grouped.set(entry.itemId, [entry]);
    }
  }
  return grouped;
}

function formatNumber(value: number, lang: CatalogLanguage): string {
  return new Intl.NumberFormat(lang === "en" ? "en-US" : "ru-RU", {
    maximumFractionDigits: 3,
    useGrouping: false,
  }).format(value);
}

/**
 * The catalog for users (TASK-020; ARCHITECTURE 4.29; M-CAT-02, M-CAT-03,
 * M-CAT-07): the items of a subcategory and the card of an item. What it
 * takes from elsewhere and never works out itself: the offers users see
 * and their receipt dates (`visibleOffers` — the showcase rule and
 * `receiptDate` of TASK-018), compatibility and the display rule D-029
 * (`CompatibilityEvaluator` of TASK-015), club access (`ClubAccess`,
 * D-059) and what a viewer may see of a supplier (`showcase-visibility`).
 *
 * A list is worked out whole in a fixed number of statements, whatever
 * the size of the subcategory — the offers, the schedules, compatibility,
 * the items, each attribute filter — and only the page is described.
 */
@Injectable()
export class ShowcaseService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CompatibilityEvaluator) private readonly compatibility: CompatibilityEvaluator,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
    @Inject(ClubAccess) private readonly access: ClubAccess,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  viewer(session: AuthenticatedSession | null): Promise<Viewer> {
    return viewerOf(session, this.access);
  }

  // ----------------------------------------------------------------- list

  async list(
    categoryId: string,
    query: ShowcaseListQuery,
    viewer: Viewer,
    lang: CatalogLanguage,
  ): Promise<ShowcaseListResponse> {
    const executor = this.database.db;
    const now = new Date();
    const subcategory = await this.visibleSubcategory(executor, categoryId);
    const [chosenCity, vehicle, weights, texts] = await Promise.all([
      this.chosenCity(executor, query.cityId, lang),
      this.vehicle(executor, query),
      this.settings.get("catalog_recommended_weights"),
      loadTexts(executor, "category", [subcategory.id]),
    ]);
    const cityId = chosenCity?.id ?? null;
    const sort = query.sort ?? "recommended";
    const limit = query.limit ?? SHOWCASE_PAGE_DEFAULT_SIZE;
    const cursor = query.cursor ? decodeListCursor(query.cursor, sort) : null;
    const answer = (found: {
      items: ShowcaseListItem[];
      total: number;
      empty: ShowcaseEmptyReason | null;
      brands: ShowcaseListResponse["brands"];
      nextCursor: string | null;
    }): ShowcaseListResponse => ({
      language: lang,
      category: {
        id: subcategory.id,
        kind: subcategory.kind,
        name: localize(textsOf(texts, subcategory.id, "name"), lang) ?? NO_NAME,
        compatibilityRequired: subcategory.compatibilityRequired,
      },
      city: chosenCity,
      vehicle,
      viewer: describeViewer(viewer),
      ...found,
    });

    // Services only ever by the chosen city (PRODUCT 6.3, D-031).
    if (subcategory.kind === "services" && cityId === null) {
      return answer({ items: [], total: 0, empty: "city_required", brands: [], nextCursor: null });
    }
    const offered = groupByItem(
      offersInReach(
        subcategory.kind,
        await visibleOffers(executor, { categoryId: subcategory.id }, now),
        cityId,
      ),
    );

    // Compatibility and D-029 — the one calculation, for the whole
    // subcategory in one statement (by the subcategory rather than by a
    // list of thousands of ids: the same result, measured ~40 times faster
    // on 3 000 items), then kept for the offered items.
    const results = (
      await this.compatibility.evaluate(
        vehicle,
        { kind: "category", categoryId: subcategory.id },
        executor,
      )
    ).filter((result) => offered.has(result.itemId));
    const resultOf = new Map(results.map((result) => [result.itemId, result]));
    const listed = results.filter((result) => result.listed).map((result) => result.itemId);
    const items =
      listed.length === 0
        ? []
        : await executor.select().from(catalogItem).where(inArray(catalogItem.id, listed));
    const itemById = new Map(items.map((row) => [row.id, row]));
    const brands = await this.brandFacet(executor, items);

    // The filters: of offers first (an item stays when an offer passes them all), then of items.
    const offerFilter = (entry: VisibleOffer) =>
      (query.availability === undefined || entry.availability === query.availability) &&
      (query.receiving === undefined ||
        (query.receiving === "pickup" ? entry.pickup : entry.delivery)) &&
      (query.onlyMyCity !== "true" || (cityId !== null && entry.cityId === cityId));
    const brandFilter = query.brandIds ? new Set(query.brandIds) : null;
    const attributePass = await this.attributeFilter(
      executor,
      subcategory.id,
      query.attributes ?? [],
      listed,
    );
    const filtered = new Map<string, VisibleOffer[]>();
    for (const itemId of listed) {
      const row = itemById.get(itemId);
      if (!row) {
        continue;
      }
      if (brandFilter && (row.brandId === null || !brandFilter.has(row.brandId))) {
        continue;
      }
      if (attributePass && !attributePass.has(itemId)) {
        continue;
      }
      const passing = (offered.get(itemId) ?? []).filter(offerFilter);
      if (passing.length > 0) {
        filtered.set(itemId, passing);
      }
    }

    // «Рекомендуемые» of a next page is ranked in the frame of the first (TASK-020.A).
    const frame = cursor?.frame ?? rankFrame(filtered, weights);
    const ranked = rankItems(filtered, sort, cityId, frame);
    const remaining = cursor ? after(ranked, cursor.key) : ranked;
    const page = remaining.slice(0, limit);
    const last = page.at(-1);
    const empty: ShowcaseEmptyReason | null =
      ranked.length > 0
        ? null
        : listed.length > 0
          ? "filters"
          : offered.size > 0 && vehicle !== null
            ? "vehicle"
            : "no_items";
    const described = await this.describeListItems(
      executor,
      subcategory,
      page.map((entry) => itemById.get(entry.itemId)!),
      lang,
    );
    return answer({
      items: page.map((entry) => ({
        ...described.get(entry.itemId)!,
        compatibility: resultOf.get(entry.itemId)!,
        offers: summarize(filtered.get(entry.itemId)!, cityId),
      })),
      total: ranked.length,
      empty,
      brands,
      nextCursor: remaining.length > limit && last ? encodeListCursor(sort, last.key, frame) : null,
    });
  }

  // ----------------------------------------------------------------- card

  async card(
    itemId: string,
    query: ShowcaseItemQuery,
    viewer: Viewer,
    lang: CatalogLanguage,
  ): Promise<ShowcaseItemResponse> {
    const executor = this.database.db;
    const now = new Date();
    const [row] = await executor.select().from(catalogItem).where(eq(catalogItem.id, itemId));
    if (!row || row.status !== "active") {
      throw notFound("item");
    }
    const subcategory = await this.visibleSubcategory(executor, row.categoryId).catch(() => {
      throw notFound("item");
    });
    const [chosenCity, vehicle, weights] = await Promise.all([
      this.chosenCity(executor, query.cityId, lang),
      this.vehicle(executor, query),
      this.settings.get("catalog_recommended_weights"),
    ]);
    const cityId = chosenCity?.id ?? null;

    const [offersOfItem, [compatibility], fitsFor, photos, attributes, analogIds, texts] =
      await Promise.all([
        visibleOffers(executor, { itemIds: [row.id] }, now),
        this.compatibility.evaluate(vehicle, { kind: "items", itemIds: [row.id] }, executor),
        this.fitsFor(executor, row.id),
        this.photos.clientPhotosOf(executor, row),
        this.attributeValues(executor, subcategory.id, [row.id], lang, "all"),
        this.analogIds(executor, row.id),
        loadTexts(executor, "category", [subcategory.id, subcategory.parentId!]),
      ]);
    const offers = sortOffers(
      offersInReach(subcategory.kind, offersOfItem, cityId),
      query.sort ?? "recommended",
      cityId,
      weights,
    );
    const [suppliers, cityNames, analogs] = await Promise.all([
      offerSuppliers(executor, viewer, offers),
      this.cityNames(
        executor,
        offers.map((entry) => entry.cityId),
        lang,
      ),
      this.analogs(executor, analogIds, vehicle, cityId, lang, now),
    ]);
    const [described] = (await this.describeListItems(executor, subcategory, [row], lang)).values();
    return {
      language: lang,
      city: chosenCity,
      vehicle,
      viewer: describeViewer(viewer),
      item: {
        id: row.id,
        type: row.itemType,
        name: described!.name,
        brand: described!.brand,
        article: row.article,
        category: {
          id: subcategory.id,
          name: localize(textsOf(texts, subcategory.id, "name"), lang) ?? NO_NAME,
          parentName: localize(textsOf(texts, subcategory.parentId!, "name"), lang),
          compatibilityRequired: subcategory.compatibilityRequired,
        },
        photos,
        attributes: attributes.get(row.id) ?? [],
      },
      // The item is shown whatever the result — it was opened directly;
      // «does not fit» comes with `requiresConfirmation` (D-029).
      compatibility: compatibility!,
      fitsFor,
      offers: offers.map((entry): ShowcaseOffer => ({
        id: entry.id,
        price: entry.price,
        currency: "KZT",
        availability: entry.availability,
        leadDays: entry.leadDays,
        pickup: entry.pickup,
        delivery: entry.delivery,
        receipt: entry.receipt,
        warrantyMonths: entry.warrantyMonths,
        ...clubOnlyOfferFields(viewer, entry),
        city: { id: entry.cityId, name: cityNames.get(entry.cityId) ?? NO_NAME },
        inCity: cityId !== null && entry.cityId === cityId,
        verifiedPartner: entry.verified,
        rating: null,
        newSupplier: true,
        supplier: suppliers.get(entry.id)!,
      })),
      noOffers: offers.length === 0,
      analogs,
    };
  }

  // ------------------------------------------------------------- helpers

  /** An active subcategory under an active node; anything else — 404. */
  private async visibleSubcategory(executor: DbExecutor, categoryId: string): Promise<CategoryRow> {
    const [row] = await executor.select().from(category).where(eq(category.id, categoryId));
    if (!row || row.status !== "active" || row.level !== 2 || !row.parentId) {
      throw notFound("category");
    }
    const [parent] = await executor
      .select({ status: category.status })
      .from(category)
      .where(eq(category.id, row.parentId));
    if (parent?.status !== "active") {
      throw notFound("category");
    }
    return row;
  }

  private async chosenCity(
    executor: DbExecutor,
    cityId: string | undefined,
    lang: CatalogLanguage,
  ): Promise<ShowcaseCity | null> {
    if (cityId === undefined) {
      return null;
    }
    const [row] = await executor.select().from(city).where(eq(city.id, cityId));
    if (!row || row.status !== "active") {
      throw validationError("cityId", "Not an active city (GET /cities)");
    }
    return { id: row.id, name: localizedCityName(row, lang) };
  }

  private async cityNames(
    executor: DbExecutor,
    cityIds: readonly string[],
    lang: CatalogLanguage,
  ): Promise<Map<string, LocalizedText>> {
    const ids = [...new Set(cityIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await executor.select().from(city).where(inArray(city.id, ids));
    return new Map(rows.map((row) => [row.id, localizedCityName(row, lang)]));
  }

  private async vehicle(
    executor: DbExecutor,
    query: VehicleQuery,
  ): Promise<ResolvedCompatibilityVehicle | null> {
    const given = vehicleOf(query);
    return given ? resolveVehicle(executor, given) : null;
  }

  /** The brands of the listed items, with how many items each, by name. */
  private async brandFacet(
    executor: DbExecutor,
    items: readonly CatalogItemRow[],
  ): Promise<ShowcaseListResponse["brands"]> {
    const counts = new Map<string, number>();
    for (const row of items) {
      if (row.brandId) {
        counts.set(row.brandId, (counts.get(row.brandId) ?? 0) + 1);
      }
    }
    const names = await this.brandNames(executor, [...counts.keys()]);
    return [...counts.entries()]
      .map(([id, count]) => ({ id, name: names.get(id) ?? "", count }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id));
  }

  private async brandNames(
    executor: DbExecutor,
    brandIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (brandIds.length === 0) {
      return new Map();
    }
    const rows = await executor
      .select({ brandId: brandSpelling.brandId, name: brandSpelling.text })
      .from(brandSpelling)
      .where(and(inArray(brandSpelling.brandId, [...brandIds]), eq(brandSpelling.isName, true)));
    return new Map(rows.map((row) => [row.brandId, row.name]));
  }

  /**
   * The items that pass every attribute filter (M-CAT-03), one statement
   * per filter; `null` — no filter applies. A filter by an attribute that
   * isn't an active filterable one of the subcategory filters nothing (an
   * archived attribute, a stale client); a filter of the wrong kind for its
   * attribute is refused. An item without a value never passes.
   */
  private async attributeFilter(
    executor: DbExecutor,
    categoryId: string,
    filters: readonly ShowcaseAttributeFilter[],
    itemIds: readonly string[],
  ): Promise<Set<string> | null> {
    if (filters.length === 0) {
      return null;
    }
    const usable = await executor
      .select()
      .from(attribute)
      .where(
        and(
          eq(attribute.categoryId, categoryId),
          eq(attribute.status, "active"),
          eq(attribute.isFilterable, true),
          inArray(
            attribute.id,
            filters.map((filter) => filter.attributeId),
          ),
        ),
      );
    const byId = new Map(usable.map((row) => [row.id, row]));
    let passing = null as Set<string> | null;
    for (const [index, filter] of filters.entries()) {
      const definition = byId.get(filter.attributeId);
      if (!definition) {
        continue;
      }
      const condition = this.valueCondition(definition, filter, index);
      if (itemIds.length === 0) {
        return new Set();
      }
      const rows = await executor
        .select({ itemId: itemAttributeValue.itemId })
        .from(itemAttributeValue)
        .where(
          and(
            eq(itemAttributeValue.attributeId, definition.id),
            inArray(itemAttributeValue.itemId, [...itemIds]),
            condition,
          ),
        );
      const found = new Set(rows.map((entry) => entry.itemId));
      const before: Set<string> | null = passing;
      passing = before === null ? found : new Set([...before].filter((id) => found.has(id)));
    }
    return passing;
  }

  private valueCondition(definition: AttributeRow, filter: ShowcaseAttributeFilter, index: number) {
    const path = `attributes.${index}`;
    switch (definition.valueType) {
      case "enum":
        if (!filter.optionIds) {
          throw validationError(path, "A list attribute is filtered by optionIds");
        }
        return inArray(itemAttributeValue.valueOptionId, filter.optionIds);
      case "number": {
        if (filter.min === undefined && filter.max === undefined) {
          throw validationError(path, "A number attribute is filtered by min and/or max");
        }
        return and(
          filter.min === undefined
            ? undefined
            : sql`${itemAttributeValue.valueNum} >= ${filter.min}`,
          filter.max === undefined
            ? undefined
            : sql`${itemAttributeValue.valueNum} <= ${filter.max}`,
        );
      }
      case "bool":
        if (filter.value === undefined) {
          throw validationError(path, "A yes/no attribute is filtered by value");
        }
        return eq(itemAttributeValue.valueBool, filter.value);
      default:
        throw validationError(path, "A text attribute can't be filtered by");
    }
  }

  /**
   * The characteristics of items in words, in the subcategory's order —
   * only those with a value. `key`: at most `SHOWCASE_KEY_ATTRIBUTES` of
   * the active filterable ones (the key characteristics of a list card).
   */
  private async attributeValues(
    executor: DbExecutor,
    categoryId: string,
    itemIds: readonly string[],
    lang: CatalogLanguage,
    which: "all" | "key",
  ): Promise<Map<string, ShowcaseAttributeValue[]>> {
    const described = new Map<string, ShowcaseAttributeValue[]>();
    if (itemIds.length === 0) {
      return described;
    }
    const definitions = await executor
      .select()
      .from(attribute)
      .where(
        and(
          eq(attribute.categoryId, categoryId),
          eq(attribute.status, "active"),
          ...(which === "key" ? [eq(attribute.isFilterable, true)] : []),
        ),
      )
      .orderBy(asc(attribute.sort), asc(attribute.code));
    if (definitions.length === 0) {
      return described;
    }
    const values = await executor
      .select()
      .from(itemAttributeValue)
      .where(
        and(
          inArray(itemAttributeValue.itemId, [...itemIds]),
          inArray(
            itemAttributeValue.attributeId,
            definitions.map((entry) => entry.id),
          ),
        ),
      );
    const optionIds = values.flatMap((entry) => (entry.valueOptionId ? [entry.valueOptionId] : []));
    const [options, attributeTexts, optionTexts] = await Promise.all([
      optionIds.length === 0
        ? []
        : executor
            .select({ id: attributeOption.id, status: attributeOption.status })
            .from(attributeOption)
            .where(inArray(attributeOption.id, optionIds)),
      loadTexts(
        executor,
        "attribute",
        definitions.map((entry) => entry.id),
      ),
      loadTexts(executor, "attribute_option", optionIds),
    ]);
    const activeOptions = new Set(
      options.filter((entry) => entry.status === "active").map((entry) => entry.id),
    );
    const valueOf = new Map(values.map((entry) => [`${entry.itemId}:${entry.attributeId}`, entry]));
    const [yes, no] = YES_NO[lang];
    for (const itemId of itemIds) {
      const list: ShowcaseAttributeValue[] = [];
      for (const definition of definitions) {
        if (which === "key" && list.length >= SHOWCASE_KEY_ATTRIBUTES) {
          break;
        }
        const value = valueOf.get(`${itemId}:${definition.id}`);
        if (!value) {
          continue;
        }
        let display: LocalizedText | null = null;
        if (definition.valueType === "enum" && value.valueOptionId) {
          display = activeOptions.has(value.valueOptionId)
            ? localize(textsOf(optionTexts, value.valueOptionId, "name"), lang)
            : null;
        } else if (definition.valueType === "number" && value.valueNum !== null) {
          const unit = localize(textsOf(attributeTexts, definition.id, "unit"), lang);
          const number = formatNumber(Number(value.valueNum), lang);
          display = {
            text: unit && unit.text ? `${number} ${unit.text}` : number,
            isFallback: unit?.isFallback ?? false,
          };
        } else if (definition.valueType === "bool" && value.valueBool !== null) {
          display = { text: value.valueBool ? yes : no, isFallback: false };
        } else if (definition.valueType === "text" && value.valueText) {
          display = { text: value.valueText, isFallback: false };
        }
        if (!display) {
          continue;
        }
        list.push({
          attributeId: definition.id,
          code: definition.code,
          name: localize(textsOf(attributeTexts, definition.id, "name"), lang) ?? NO_NAME,
          valueType: definition.valueType,
          display,
        });
      }
      described.set(itemId, list);
    }
    return described;
  }

  /** Name, brand, article, photo and key characteristics of items (a list, the card, analogs). */
  private async describeListItems(
    executor: DbExecutor,
    subcategory: CategoryRow,
    items: readonly CatalogItemRow[],
    lang: CatalogLanguage,
  ): Promise<Map<string, Omit<ShowcaseListItem, "compatibility" | "offers">>> {
    const described = new Map<string, Omit<ShowcaseListItem, "compatibility" | "offers">>();
    if (items.length === 0) {
      return described;
    }
    const ids = items.map((row) => row.id);
    const [texts, brands, images, keys] = await Promise.all([
      loadTexts(executor, "catalog_item", ids),
      this.brandNames(
        executor,
        items.flatMap((row) => (row.brandId ? [row.brandId] : [])),
      ),
      this.photos.imagesFor(executor, items),
      this.attributeValues(executor, subcategory.id, ids, lang, "key"),
    ]);
    for (const row of items) {
      const brandName = row.brandId ? brands.get(row.brandId) : undefined;
      described.set(row.id, {
        id: row.id,
        type: row.itemType,
        name: localize(textsOf(texts, row.id, "name"), lang) ?? NO_NAME,
        brand: row.brandId && brandName ? { id: row.brandId, name: brandName } : null,
        article: row.article,
        photo: images.get(row.id) ?? null,
        keyAttributes: keys.get(row.id) ?? [],
      });
    }
    return described;
  }

  /** «Подходит для»: the approved records of the item in words. */
  private async fitsFor(executor: DbExecutor, itemId: string) {
    const records = await executor
      .select()
      .from(itemCompatibility)
      .where(and(eq(itemCompatibility.itemId, itemId), eq(itemCompatibility.status, "approved")))
      .orderBy(asc(itemCompatibility.createdAt), asc(itemCompatibility.id));
    return describeConditions(executor, records);
  }

  private async analogIds(executor: DbExecutor, itemId: string): Promise<string[]> {
    const rows = await executor
      .select({ itemId: itemAnalog.itemId, analogItemId: itemAnalog.analogItemId })
      .from(itemAnalog)
      .where(
        and(
          or(eq(itemAnalog.itemId, itemId), eq(itemAnalog.analogItemId, itemId)),
          eq(itemAnalog.status, "approved"),
        ),
      );
    return rows.map((row) => (row.itemId === itemId ? row.analogItemId : row.itemId));
  }

  /**
   * Analogs as links (M-CAT-07, D-031): only those users can get — active
   * items with visible offers, a service only in the chosen city
   * (`offersInReach`, as the list and the card) — and, as in any list,
   * only those D-029 lets a list show for the car. The cheapest first.
   */
  private async analogs(
    executor: DbExecutor,
    analogIds: readonly string[],
    vehicle: ResolvedCompatibilityVehicle | null,
    cityId: string | null,
    lang: CatalogLanguage,
    now: Date,
  ): Promise<ShowcaseAnalog[]> {
    if (analogIds.length === 0) {
      return [];
    }
    const found = groupByItem(await visibleOffers(executor, { itemIds: analogIds }, now));
    if (found.size === 0) {
      return [];
    }
    const kinds = await executor
      .select({ itemId: catalogItem.id, kind: category.kind })
      .from(catalogItem)
      .innerJoin(category, eq(category.id, catalogItem.categoryId))
      .where(inArray(catalogItem.id, [...found.keys()]));
    const offers = new Map<string, VisibleOffer[]>();
    for (const { itemId, kind } of kinds) {
      const reachable = offersInReach(kind, found.get(itemId) ?? [], cityId);
      if (reachable.length > 0) {
        offers.set(itemId, reachable);
      }
    }
    if (offers.size === 0) {
      return [];
    }
    const results: CompatibilityItemResult[] = await this.compatibility.evaluate(
      vehicle,
      { kind: "items", itemIds: [...offers.keys()] },
      executor,
    );
    const shown = results.filter((result) => result.listed);
    if (shown.length === 0) {
      return [];
    }
    const rows = await executor
      .select()
      .from(catalogItem)
      .where(
        inArray(
          catalogItem.id,
          shown.map((result) => result.itemId),
        ),
      );
    const bySubcategory = new Map<string, CatalogItemRow[]>();
    for (const row of rows) {
      bySubcategory.set(row.categoryId, [...(bySubcategory.get(row.categoryId) ?? []), row]);
    }
    const described = new Map<string, Omit<ShowcaseListItem, "compatibility" | "offers">>();
    for (const [subcategoryId, list] of bySubcategory) {
      const [subcategory] = await executor
        .select()
        .from(category)
        .where(eq(category.id, subcategoryId));
      for (const [id, entry] of await this.describeListItems(executor, subcategory!, list, lang)) {
        described.set(id, entry);
      }
    }
    return shown
      .flatMap((result) => {
        const entry = described.get(result.itemId);
        const itemOffers = offers.get(result.itemId);
        if (!entry || !itemOffers) {
          return [];
        }
        return [
          {
            id: entry.id,
            name: entry.name,
            brand: entry.brand,
            article: entry.article,
            photo: entry.photo,
            compatibility: result,
            offers: summarize(itemOffers, cityId),
          },
        ];
      })
      .sort((a, b) => a.offers.minPrice - b.offers.minPrice || a.id.localeCompare(b.id))
      .slice(0, SHOWCASE_ANALOGS_MAX);
  }
}
