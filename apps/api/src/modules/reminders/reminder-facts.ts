import { Inject, Injectable } from "@nestjs/common";
import type { CompatibilityVehicle, ResolvedCompatibilityVehicle } from "@adclub/contracts";
import {
  maintenanceAgeMonths,
  readingNear,
  reminderState,
  type ReminderBasis,
  type ReminderCarState,
  type ReminderItem,
  type ReminderReading,
} from "@adclub/domain";
import { and, eq, inArray } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { catalogItem } from "../catalog";
import { CompatibilityEvaluator, resolveVehicle } from "../compatibility";
import { accountCar, mileageLog, type AccountCarRow } from "../garage";
import { MaintenanceAnswers, targetProblems, type MaintenancePlanItemRow } from "../maintenance";
import { customerOrder } from "../orders";
import { AppSettings, type SettingValues } from "../settings";
import { ShowcaseService } from "../showcase";
import { maintenanceReminder, type MaintenanceReminderRow } from "./schema";

/** The time zone the age of a car is counted in (ARCHITECTURE 13.3). */
const TIME_ZONE = "Asia/Almaty";

function almatyMonth(at: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month") };
}

/** A car of the garage as the compatibility check and the plans take it. */
export function vehicleOfCar(car: AccountCarRow): CompatibilityVehicle {
  return {
    ...(car.modificationId ? { modificationId: car.modificationId } : {}),
    makeId: car.makeId,
    modelId: car.modelId,
    ...(car.generationId ? { generationId: car.generationId } : {}),
    ...(car.bodyTypeId ? { bodyTypeId: car.bodyTypeId } : {}),
    ...(car.engineId ? { engineId: car.engineId } : {}),
    ...(car.transmissionTypeId ? { transmissionTypeId: car.transmissionTypeId } : {}),
    ...(car.driveTypeId ? { driveTypeId: car.driveTypeId } : {}),
    ...(car.year !== null ? { year: car.year } : {}),
  };
}

/** «Geely Coolray 2024» — how a push and a card name a car. */
export function carLabelOf(car: AccountCarRow): string {
  return [car.makeLabel, car.modelLabel, car.year === null ? null : String(car.year)]
    .filter(Boolean)
    .join(" ");
}

/** The replacement a push was about: a new replacement (or a snooze cleared) is a new push. */
export function cycleOf(item: ReminderItem): string {
  return [
    item.basis.source,
    item.basis.at?.toISOString() ?? "",
    item.basis.atKm ?? "",
    item.dueKm ?? "",
    item.dueDate?.toISOString() ?? "",
  ].join("|");
}

export interface CarReminderFacts {
  car: AccountCarRow;
  /** `null` — the vehicle catalog no longer understands the car: no plan. */
  vehicle: ResolvedCompatibilityVehicle | null;
  /** The active elements of the car's plan; empty — no plan. */
  planRows: MaintenancePlanItemRow[];
  /** The car has an active plan (its elements may still be none). */
  hasPlan: boolean;
  rows: Map<string, MaintenanceReminderRow>;
  state: ReminderCarState;
  /** The numbers of the orders a replacement is counted from («по заявке № N»). */
  orderNumbers: Map<string, number>;
}

interface FinishedOrder {
  id: string;
  number: number;
  kind: string;
  carId: string | null;
  itemId: string;
  at: Date;
}

/**
 * The facts of the one rule (TASK-069; ARCHITECTURE 4.87): the cars of an
 * account, each one's plan (the choice of `GET /maintenance/plan`), its
 * readings, what is kept of its reminders, and the replacements its finished
 * orders made — then `reminderState`. The daily job and the routes of the
 * app and the admin panel take only this; nobody counts a reminder anywhere
 * else.
 *
 * An order is a replacement of an element when it is finished, not a test,
 * of an item the element's rule leads to now (the rule that leads nowhere —
 * `targetProblems` — counts nothing), and of this car: an order on a service
 * names its car; an item is this car's only when it fits exactly one car of
 * the garage (`CompatibilityEvaluator`) — a false reset is worse than an
 * extra reminder, and «Уже поменял» is always there.
 */
@Injectable()
export class ReminderFacts {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(CompatibilityEvaluator) private readonly compatibility: CompatibilityEvaluator,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
    @Inject(MaintenanceAnswers) private readonly maintenance: MaintenanceAnswers,
  ) {}

  /** Every car of the account (`carId` — that one only), most recently added first. */
  async forAccount(
    accountId: string,
    options: {
      executor?: DbExecutor;
      now?: Date;
      carId?: string;
      /**
       * The settings, read before a transaction is opened: a read of them
       * inside one would wait for a second connection while holding the first.
       */
      settings?: Readonly<SettingValues>;
    } = {},
  ): Promise<CarReminderFacts[]> {
    const executor = options.executor ?? this.database.db;
    const now = options.now ?? new Date();
    const cars = await executor
      .select()
      .from(accountCar)
      .where(eq(accountCar.accountId, accountId));
    if (cars.length === 0) return [];
    const carIds = cars.map((car) => car.id);
    const settings = options.settings ?? (await this.settings.values());
    // One statement at a time: the executor may be a transaction (one connection).
    const readings = await executor
      .select()
      .from(mileageLog)
      .where(inArray(mileageLog.carId, carIds));
    const kept = await executor
      .select()
      .from(maintenanceReminder)
      .where(inArray(maintenanceReminder.carId, carIds));
    const orders = await this.finishedOrders(executor, accountId);
    const vehicles = new Map<string, ResolvedCompatibilityVehicle | null>();
    for (const car of cars) {
      vehicles.set(car.id, await this.resolve(executor, car));
    }
    const orderCars = await this.carsOfOrders(executor, orders, cars, vehicles);
    const chosen = options.carId ? cars.filter((car) => car.id === options.carId) : cars;
    chosen.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const result: CarReminderFacts[] = [];
    for (const car of chosen) {
      const vehicle = vehicles.get(car.id) ?? null;
      const plan = vehicle ? await this.maintenance.activePlanOf(executor, vehicle) : null;
      const planRows = plan?.rows ?? [];
      const carReadings: ReminderReading[] = readings
        .filter((reading) => reading.carId === car.id)
        .map((reading) => ({ valueKm: reading.valueKm, at: reading.recordedAt }));
      const rows = new Map(
        kept.filter((row) => row.carId === car.id).map((row) => [row.planItemId, row]),
      );
      const carOrders = orders.filter((order) => orderCars.get(order.id) === car.id);
      const replaced = await this.ordersByElement(executor, planRows, carOrders);
      const orderNumbers = new Map(carOrders.map((order) => [order.id, order.number]));
      const state = reminderState(
        {
          hasPlan: plan !== null,
          readings: carReadings,
          knownSince: car.createdAt,
          ageMonthsAtKnownSince: vehicle
            ? maintenanceAgeMonths(vehicle, almatyMonth(car.createdAt))
            : null,
          mileageQuestionDismissedUntil: car.mileageQuestionDismissedUntil,
          mileageConfirmedAt: car.mileageConfirmedAt,
          elements: planRows.map((row) => ({
            id: row.id,
            position: row.position,
            intervalKm: row.intervalKm,
            intervalMonths: row.intervalMonths,
            firstKm: row.firstKm,
            firstMonths: row.firstMonths,
            basis: latestBasis(rows.get(row.id), replaced.get(row.id) ?? [], carReadings),
            snoozedUntil: rows.get(row.id)?.snoozedUntil ?? null,
          })),
        },
        {
          leadKm: settings.reminder_lead_km,
          leadDays: settings.reminder_lead_days,
          askDays: settings.mileage_ask_days,
          windowDays: settings.reminder_mileage_window_days,
        },
        now,
      );
      result.push({ car, vehicle, planRows, hasPlan: plan !== null, rows, state, orderNumbers });
    }
    return result;
  }

  private async resolve(
    executor: DbExecutor,
    car: AccountCarRow,
  ): Promise<ResolvedCompatibilityVehicle | null> {
    try {
      return await resolveVehicle(executor, vehicleOfCar(car));
    } catch {
      // A level archived or made inconsistent since the car was saved: no plan, no reminder.
      return null;
    }
  }

  private async finishedOrders(executor: DbExecutor, accountId: string): Promise<FinishedOrder[]> {
    const rows = await executor
      .select({
        id: customerOrder.id,
        number: customerOrder.number,
        kind: customerOrder.kind,
        carId: customerOrder.carId,
        itemId: customerOrder.itemId,
        closedAt: customerOrder.closedAt,
        finishedAt: customerOrder.finishedAt,
        updatedAt: customerOrder.updatedAt,
      })
      .from(customerOrder)
      .where(
        and(
          eq(customerOrder.userAccountId, accountId),
          eq(customerOrder.status, "completed"),
          eq(customerOrder.isTest, false),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      kind: row.kind,
      carId: row.carId,
      itemId: row.itemId,
      at: row.closedAt ?? row.finishedAt ?? row.updatedAt,
    }));
  }

  /**
   * The car of each finished order: a service names it; an item is the car
   * it fits when it fits exactly one of the garage — otherwise none.
   */
  private async carsOfOrders(
    executor: DbExecutor,
    orders: readonly FinishedOrder[],
    cars: readonly AccountCarRow[],
    vehicles: ReadonlyMap<string, ResolvedCompatibilityVehicle | null>,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const own = new Set(cars.map((car) => car.id));
    const goods = orders.filter((order) => order.kind !== "service");
    const itemIds = [...new Set(goods.map((order) => order.itemId))];
    const fitsBy = new Map<string, string[]>();
    if (itemIds.length > 0) {
      for (const car of cars) {
        const vehicle = vehicles.get(car.id);
        if (!vehicle) continue;
        const results = await this.compatibility.evaluate(
          vehicle,
          { kind: "items", itemIds },
          executor,
        );
        for (const entry of results) {
          if (entry.result === "fits") {
            fitsBy.set(entry.itemId, [...(fitsBy.get(entry.itemId) ?? []), car.id]);
          }
        }
      }
    }
    for (const order of orders) {
      if (order.kind === "service") {
        if (order.carId && own.has(order.carId)) result.set(order.id, order.carId);
      } else {
        const fits = fitsBy.get(order.itemId) ?? [];
        if (fits.length === 1) result.set(order.id, fits[0]!);
      }
    }
    return result;
  }

  /** The orders of a car that replaced each element, by the element's rule as it is now. */
  private async ordersByElement(
    executor: DbExecutor,
    planRows: readonly MaintenancePlanItemRow[],
    orders: readonly FinishedOrder[],
  ): Promise<Map<string, FinishedOrder[]>> {
    const result = new Map<string, FinishedOrder[]>();
    if (planRows.length === 0 || orders.length === 0) return result;
    const itemIds = [...new Set(orders.map((order) => order.itemId))];
    const items = await executor
      .select({ id: catalogItem.id, categoryId: catalogItem.categoryId })
      .from(catalogItem)
      .where(inArray(catalogItem.id, itemIds));
    const categoryOf = new Map(items.map((item) => [item.id, item.categoryId]));
    const problems = await targetProblems(executor, planRows);
    for (const [index, row] of planRows.entries()) {
      if (problems[index]!.length > 0) continue;
      let leads: Set<string>;
      if (row.targetKind === "items") {
        leads = new Set(row.targetItemIds.filter((id) => itemIds.includes(id)));
      } else if (row.targetKind === "category" && row.targetCategoryId) {
        const inCategory = itemIds.filter((id) => categoryOf.get(id) === row.targetCategoryId);
        const passing = await this.showcase.attributeFilter(
          executor,
          row.targetCategoryId,
          row.targetAttributes,
          inCategory,
        );
        leads = passing ?? new Set(inCategory);
      } else {
        continue;
      }
      const matched = orders.filter((order) => leads.has(order.itemId));
      if (matched.length > 0) result.set(row.id, matched);
    }
    return result;
  }
}

/**
 * The latest known replacement: «Уже поменял» or an order; the mileage of an
 * order is the reading nearest to when it was given out (none — by the date).
 */
function latestBasis(
  kept: MaintenanceReminderRow | undefined,
  orders: readonly FinishedOrder[],
  readings: readonly ReminderReading[],
): ReminderBasis | null {
  let best: ReminderBasis | null = null;
  if (kept?.doneAt) {
    best = { source: "user", atKm: kept.doneKm, at: kept.doneAt };
  }
  for (const order of orders) {
    if (best === null || order.at.getTime() > best.at.getTime()) {
      best = {
        source: "order",
        atKm: readingNear(readings, order.at)?.valueKm ?? null,
        at: order.at,
        orderId: order.id,
      };
    }
  }
  return best;
}
