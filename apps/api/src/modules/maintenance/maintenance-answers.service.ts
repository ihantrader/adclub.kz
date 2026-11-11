import { Inject, Injectable } from "@nestjs/common";
import type {
  CatalogLanguage,
  CompatibilityVehicle,
  MaintenanceCatalog,
  MaintenanceDueItem,
  MaintenanceItemProblem,
  MaintenancePlanAnswer,
  MaintenancePlanCheckBody,
  MaintenancePlanCheckResponse,
  MaintenancePlanQuery,
  ResolvedCompatibilityVehicle,
  ShowcaseListQuery,
} from "@adclub/contracts";
import {
  dueMaintenance,
  maintenanceAgeMonths,
  maintenancePlanFor,
  maintenanceScopeMatches,
  type MaintenanceElement,
} from "@adclub/domain";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { catalogItem, loadTexts, localize, textsOf } from "../catalog";
import { resolveVehicle } from "../compatibility";
import { ShowcaseService, type Viewer } from "../showcase";
import { planCandidatesWhere, scopeOf } from "./maintenance-scope";
import { targetProblems } from "./maintenance-targets";
import { maintenancePlan, maintenancePlanItem, type MaintenancePlanItemRow } from "./schema";

/** The time zone the age of a car is counted in (ARCHITECTURE 13.3). */
const TIME_ZONE = "Asia/Almaty";

function almatyMonth(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month") };
}

type Element = MaintenanceElement & { row: MaintenancePlanItemRow };

function elementOf(row: MaintenancePlanItemRow): Element {
  return {
    id: row.id,
    position: row.position,
    intervalKm: row.intervalKm,
    intervalMonths: row.intervalMonths,
    firstKm: row.firstKm,
    firstMonths: row.firstMonths,
    serviceCodes: row.serviceCodes,
    row,
  };
}

/** The car of a query as the compatibility check takes it; `null` — none given. */
function vehicleOfQuery(query: MaintenancePlanQuery): CompatibilityVehicle | null {
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

/** The car's levels as the list of a subcategory takes them in its query. */
function listVehicleQuery(car: ResolvedCompatibilityVehicle): Partial<ShowcaseListQuery> {
  return {
    ...(car.modificationId ? { vehicleModificationId: car.modificationId } : {}),
    vehicleMakeId: car.makeId,
    ...(car.modelId ? { vehicleModelId: car.modelId } : {}),
    ...(car.generationId ? { vehicleGenerationId: car.generationId } : {}),
    ...(car.bodyTypeId ? { vehicleBodyTypeId: car.bodyTypeId } : {}),
    ...(car.engineId ? { vehicleEngineId: car.engineId } : {}),
    ...(car.transmissionTypeId ? { vehicleTransmissionTypeId: car.transmissionTypeId } : {}),
    ...(car.driveTypeId ? { vehicleDriveTypeId: car.driveTypeId } : {}),
    ...(car.year !== null ? { vehicleYear: car.year } : {}),
  };
}

const NO_CATALOG = (row: MaintenancePlanItemRow): MaintenanceCatalog => ({
  unavailable: false,
  count: 0,
  minPrice: null,
  currency: "KZT",
  cityRequired: false,
  categoryId: row.targetCategoryId,
  filters: row.targetAttributes,
  itemIds: row.targetItemIds,
});

/**
 * A rule that leads nowhere now: nothing is sold by it and nothing is
 * opened — not the subcategory without the condition that is gone (the
 * client list skips a filter it no longer knows, which would widen it).
 */
const UNAVAILABLE: MaintenanceCatalog = {
  unavailable: true,
  count: 0,
  minPrice: null,
  currency: "KZT",
  cityRequired: false,
  categoryId: null,
  filters: [],
  itemIds: [],
};

/**
 * «Что положено автомобилю» (TASK-061 requirement 3; ARCHITECTURE 4.84):
 * the plan of a car — `maintenancePlanFor` over the candidates of its SQL
 * twin — its due elements — `dueMaintenance` — and, for each, what the
 * platform sells by its rule for this car and city. That last number is
 * never worked out here: it is the `total` of the client list of the
 * subcategory with the rule's filters, the car and the city
 * (`ShowcaseService.list`, TASK-020), so it is exactly what the catalog
 * shows — the visible offers, D-029 by the car, a city for services.
 */
@Injectable()
export class MaintenanceAnswers {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
  ) {}

  async answer(
    query: MaintenancePlanQuery,
    viewer: Viewer,
    lang: CatalogLanguage,
  ): Promise<MaintenancePlanAnswer> {
    const executor = this.database.db;
    // The city is checked first: an inactive one is a 400 whatever the plan has (TASK-061.A).
    await this.showcase.chosenCity(executor, query.cityId, lang);
    const given = vehicleOfQuery(query);
    const empty: Pick<
      MaintenancePlanAnswer,
      "language" | "plan" | "reason" | "items" | "serviceKm" | "nextServiceKm"
    > = {
      language: lang,
      plan: null,
      reason: null,
      items: [],
      serviceKm: null,
      nextServiceKm: null,
    };
    if (!given) {
      return { ...empty, vehicle: null, noPlan: "needs_details", missing: ["make"] };
    }
    const car = await resolveVehicle(executor, given);
    const candidates = await executor
      .select()
      .from(maintenancePlan)
      .where(planCandidatesWhere(car));
    const choice = maintenancePlanFor(
      car,
      candidates.map((row) => ({ id: row.id, status: row.status, scope: scopeOf(row), row })),
    );
    if (choice.kind !== "plan") {
      return {
        ...empty,
        vehicle: car,
        noPlan: choice.kind,
        missing: choice.kind === "needs_details" ? choice.missing : [],
      };
    }
    const plan = choice.plan.row;
    const rows = await executor
      .select()
      .from(maintenancePlanItem)
      .where(and(eq(maintenancePlanItem.planId, plan.id), eq(maintenancePlanItem.status, "active")))
      .orderBy(asc(maintenancePlanItem.position), asc(maintenancePlanItem.id));
    const due = this.due(rows, car, query);
    const items = await this.dueItems(executor, due.items, car, query.cityId, viewer, lang);
    return {
      language: lang,
      vehicle: car,
      plan: {
        id: plan.id,
        scope: scopeOf(plan),
        source: plan.source,
        serviceCodes: serviceCodesOf(rows),
      },
      noPlan: null,
      missing: [],
      reason: due.reason,
      items: items.map(({ item }) => item),
      serviceKm: due.serviceKm,
      nextServiceKm: due.nextServiceKm,
    };
  }

  /**
   * The check of one plan, whatever its status (TASK-061 requirement 3):
   * every element that is not archived — the proposed ones too — with how
   * many items of its rule the catalog has at all and how many are sold.
   */
  async check(
    planId: string,
    body: MaintenancePlanCheckBody,
  ): Promise<MaintenancePlanCheckResponse> {
    const executor = this.database.db;
    const [plan] = await executor
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, planId));
    if (!plan) throw new ApiException(404, "NOT_FOUND", "No such maintenance plan");
    await this.showcase.chosenCity(executor, body.cityId, "ru");
    const car = await resolveVehicle(executor, body.vehicle);
    const scope = maintenanceScopeMatches(scopeOf(plan), car);
    const rows = await executor
      .select()
      .from(maintenancePlanItem)
      .where(
        and(eq(maintenancePlanItem.planId, plan.id), ne(maintenancePlanItem.status, "archived")),
      )
      .orderBy(asc(maintenancePlanItem.position), asc(maintenancePlanItem.id));
    const query = {
      ...(body.mileageKm === undefined ? {} : { mileageKm: body.mileageKm }),
      ...(body.serviceCode === undefined ? {} : { serviceCode: body.serviceCode }),
    };
    const due = this.due(rows, car, query);
    const viewer = await this.showcase.viewer(null);
    const items = await this.dueItems(executor, due.items, car, body.cityId, viewer, "ru");
    const totals = await Promise.all(
      items.map(({ row, problems }) =>
        problems.length > 0 ? 0 : this.catalogTotal(executor, row),
      ),
    );
    return {
      scope: {
        result: scope.result,
        missing: scope.result === "needs_details" ? scope.missing : [],
      },
      vehicle: car,
      reason: due.reason,
      items: items.map(({ item, row }, index) => ({
        ...item,
        status: row.status,
        catalogTotal: totals[index]!,
        problems: items[index]!.problems,
      })),
      serviceKm: due.serviceKm,
      nextServiceKm: due.nextServiceKm,
    };
  }

  private due(
    rows: readonly MaintenancePlanItemRow[],
    car: ResolvedCompatibilityVehicle,
    query: { mileageKm?: number; serviceCode?: string },
  ) {
    // A lower bound of the age: the year, or the youngest car of the generation (4.84 I949).
    const ageMonths = maintenanceAgeMonths(car, almatyMonth(new Date()));
    return dueMaintenance(rows.map(elementOf), {
      ...(query.mileageKm === undefined ? {} : { mileageKm: query.mileageKm }),
      ...(query.serviceCode === undefined ? {} : { serviceCode: query.serviceCode }),
      ...(ageMonths === null ? {} : { ageMonths }),
    });
  }

  private async dueItems(
    executor: DbExecutor,
    due: ReturnType<MaintenanceAnswers["due"]>["items"],
    car: ResolvedCompatibilityVehicle,
    cityId: string | undefined,
    viewer: Viewer,
    lang: CatalogLanguage,
  ): Promise<
    { item: MaintenanceDueItem; row: MaintenancePlanItemRow; problems: MaintenanceItemProblem[] }[]
  > {
    const rows = due.map((entry) => entry.element.row);
    const [titles, problems] = await Promise.all([
      loadTexts(
        executor,
        "maintenance_plan_item",
        rows.map((row) => row.id),
      ),
      // The one rule of «leads to the catalog now» — the administrator's problems (4.84 I947).
      targetProblems(executor, rows),
    ]);
    const catalogs = await Promise.all(
      rows.map((row, index) =>
        problems[index]!.length > 0
          ? UNAVAILABLE
          : this.sold(executor, row, car, cityId, viewer, lang),
      ),
    );
    return due.map((entry, index) => {
      const row = entry.element.row;
      return {
        row,
        problems: problems[index]!,
        item: {
          id: row.id,
          title: localize(textsOf(titles, row.id, "name"), lang) ?? { text: "", isFallback: true },
          kind: row.kind,
          reason: entry.reason,
          atKm: entry.atKm,
          atMonths: entry.atMonths,
          intervalKm: row.intervalKm,
          intervalMonths: row.intervalMonths,
          quantity: row.quantity,
          catalog: catalogs[index]!,
        },
      };
    });
  }

  /**
   * What the platform sells by the rule: the client list of the
   * subcategory with the rule's filters (sorted «дешевле», so its first item
   * carries the lowest price) — or, for particular items, the lists of their
   * subcategories kept to them. A subcategory the client can't open counts
   * nothing; a service without a city is not counted (`cityRequired`).
   */
  private async sold(
    executor: DbExecutor,
    row: MaintenancePlanItemRow,
    car: ResolvedCompatibilityVehicle,
    cityId: string | undefined,
    viewer: Viewer,
    lang: CatalogLanguage,
  ): Promise<MaintenanceCatalog> {
    const base = NO_CATALOG(row);
    const query = (attributes: MaintenancePlanItemRow["targetAttributes"]): ShowcaseListQuery => ({
      ...listVehicleQuery(car),
      ...(cityId ? { cityId } : {}),
      ...(attributes.length > 0 ? { attributes } : {}),
      sort: "cheaper",
      limit: 1,
    });
    const list = async (
      categoryId: string,
      attributes: typeof row.targetAttributes,
      itemIds?: readonly string[],
    ) => {
      try {
        return await this.showcase.list(
          categoryId,
          query(attributes),
          viewer,
          lang,
          itemIds ? { itemIds } : undefined,
        );
      } catch (error) {
        // A hidden or archived subcategory: the client list is a 404 — nothing is sold by the rule.
        if (error instanceof ApiException && error.status === 404) return null;
        throw error;
      }
    };
    const fold = (answers: Awaited<ReturnType<typeof list>>[]): MaintenanceCatalog => {
      if (answers.some((answer) => answer?.empty === "city_required")) {
        return { ...base, count: null, minPrice: null, cityRequired: true };
      }
      const prices = answers.flatMap((answer) =>
        answer?.items[0] ? [answer.items[0].offers.minPrice] : [],
      );
      return {
        ...base,
        count: answers.reduce((sum, answer) => sum + (answer?.total ?? 0), 0),
        minPrice: prices.length > 0 ? Math.min(...prices) : null,
      };
    };
    if (row.targetKind === "category" && row.targetCategoryId) {
      return fold([await list(row.targetCategoryId, row.targetAttributes)]);
    }
    if (row.targetKind === "items" && row.targetItemIds.length > 0) {
      const items = await executor
        .select({ id: catalogItem.id, categoryId: catalogItem.categoryId })
        .from(catalogItem)
        .where(inArray(catalogItem.id, row.targetItemIds));
      const byCategory = new Map<string, string[]>();
      for (const item of items) {
        byCategory.set(item.categoryId, [...(byCategory.get(item.categoryId) ?? []), item.id]);
      }
      return fold(
        await Promise.all([...byCategory].map(([categoryId, ids]) => list(categoryId, [], ids))),
      );
    }
    return base;
  }

  /** How many items of the rule the catalog has at all: active, passing the conditions, on offer or not. */
  private async catalogTotal(executor: DbExecutor, row: MaintenancePlanItemRow): Promise<number> {
    if (row.targetKind === "items") {
      const rows = await executor
        .select({ id: catalogItem.id })
        .from(catalogItem)
        .where(and(inArray(catalogItem.id, row.targetItemIds), eq(catalogItem.status, "active")));
      return rows.length;
    }
    if (row.targetKind !== "category" || !row.targetCategoryId) return 0;
    const items = await executor
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(
        and(eq(catalogItem.categoryId, row.targetCategoryId), eq(catalogItem.status, "active")),
      );
    const ids = items.map((item) => item.id);
    const passing = await this.showcase.attributeFilter(
      executor,
      row.targetCategoryId,
      row.targetAttributes,
      ids,
    );
    return passing === null ? ids.length : passing.size;
  }
}

/** Every service code of the active elements, in the order «ТО-1», «ТО-2», … (by number, then text). */
export function serviceCodesOf(rows: readonly MaintenancePlanItemRow[]): string[] {
  const codes = new Map<string, string>();
  for (const row of rows) {
    for (const code of row.serviceCodes) {
      if (!codes.has(code.toLowerCase())) codes.set(code.toLowerCase(), code);
    }
  }
  const number = (code: string) => Number(/\d+/u.exec(code)?.[0] ?? Number.NaN);
  return [...codes.values()].sort((a, b) => {
    const [x, y] = [number(a), number(b)];
    if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
    return a.localeCompare(b, "ru");
  });
}

export type { MaintenanceItemProblem };
