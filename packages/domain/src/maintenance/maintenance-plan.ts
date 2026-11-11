/**
 * Maintenance plans as data (TASK-061; ARCHITECTURE 11.3, 4.84): the rules
 * that need no database — which plan applies to a car, and which elements
 * of it are due at a mileage, an age or a service code. The server decides
 * with these functions only; its SQL twin of `maintenanceScopeMatches`
 * selects the candidates, never the answer.
 */

/** The levels a plan is scoped by, from the widest to the finest. */
export type MaintenanceLevel = "make" | "model" | "generation" | "engine";

export const MAINTENANCE_LEVELS: readonly MaintenanceLevel[] = [
  "make",
  "model",
  "generation",
  "engine",
];

/** The area of a plan: a make, and optionally finer levels (`null` — any). */
export interface MaintenanceScope {
  makeId: string;
  modelId: string | null;
  generationId: string | null;
  engineId: string | null;
}

/** A car as far as plans care: its known levels (`null` — not known). */
export interface MaintenanceCar {
  makeId: string | null;
  modelId: string | null;
  generationId: string | null;
  engineId: string | null;
}

const FIELD: Record<MaintenanceLevel, keyof MaintenanceScope> = {
  make: "makeId",
  model: "modelId",
  generation: "generationId",
  engine: "engineId",
};

export type ScopeMatch =
  /** Every level the plan names is the car's. */
  | { result: "fits" }
  /** No level contradicts the car, but the car does not say these. */
  | { result: "needs_details"; missing: MaintenanceLevel[] }
  /** A level the plan names is another one of the car's. */
  | { result: "does_not_fit" };

/**
 * Whether a plan's area is the car's (requirement 2): a level the plan
 * leaves empty is any; a level it names must be the car's — unknown at the
 * car, it is missing, another one, the plan does not fit.
 */
export function maintenanceScopeMatches(scope: MaintenanceScope, car: MaintenanceCar): ScopeMatch {
  const missing: MaintenanceLevel[] = [];
  for (const level of MAINTENANCE_LEVELS) {
    const wanted = scope[FIELD[level]];
    if (wanted === null) continue;
    const known = car[FIELD[level]];
    if (known === null) {
      missing.push(level);
    } else if (known !== wanted) {
      return { result: "does_not_fit" };
    }
  }
  return missing.length === 0 ? { result: "fits" } : { result: "needs_details", missing };
}

/** How specific a scope is: the engine above the generation above the model above the make. */
function specificity(scope: MaintenanceScope): number {
  return (
    (scope.engineId === null ? 0 : 8) +
    (scope.generationId === null ? 0 : 4) +
    (scope.modelId === null ? 0 : 2) +
    1
  );
}

export interface PlanCandidate {
  id: string;
  status: "draft" | "active" | "archived";
  scope: MaintenanceScope;
}

export type PlanChoice<Plan extends PlanCandidate> =
  | { kind: "plan"; plan: Plan }
  | { kind: "needs_details"; missing: MaintenanceLevel[] }
  | { kind: "no_plan" };

/**
 * The plan of a car (requirement 2): among the active plans whose area is
 * the car's, the most specific. A plan that needs a level the car does not
 * say neither applies nor blocks a wider one; only when nothing fits, the
 * levels that would let one fit are asked for — those of the plans that
 * need the fewest, all of them when several need as few.
 */
export function maintenancePlanFor<Plan extends PlanCandidate>(
  car: MaintenanceCar,
  plans: readonly Plan[],
): PlanChoice<Plan> {
  let best: Plan | null = null;
  let fewest: Set<MaintenanceLevel> | null = null;
  let fewestCount = Number.POSITIVE_INFINITY;
  for (const plan of plans) {
    if (plan.status !== "active") continue;
    const match = maintenanceScopeMatches(plan.scope, car);
    if (match.result === "fits") {
      if (
        best === null ||
        specificity(plan.scope) > specificity(best.scope) ||
        (specificity(plan.scope) === specificity(best.scope) && plan.id < best.id)
      ) {
        best = plan;
      }
    } else if (match.result === "needs_details") {
      if (match.missing.length < fewestCount) {
        fewestCount = match.missing.length;
        fewest = new Set(match.missing);
      } else if (match.missing.length === fewestCount && fewest) {
        for (const level of match.missing) fewest.add(level);
      }
    }
  }
  if (best) return { kind: "plan", plan: best };
  if (fewest) {
    return {
      kind: "needs_details",
      missing: MAINTENANCE_LEVELS.filter((level) => fewest.has(level)),
    };
  }
  return { kind: "no_plan" };
}

// --------------------------------------------------------------- what is due

/** The interval limits of an element (business rules of TASK-061). */
export const MAINTENANCE_KM_MIN = 1_000;
export const MAINTENANCE_KM_MAX = 120_000;
export const MAINTENANCE_MONTHS_MIN = 1;
export const MAINTENANCE_MONTHS_MAX = 120;

/** An element of a plan, as far as «is it due» cares. */
export interface MaintenanceElement {
  id: string;
  position: number;
  intervalKm: number | null;
  intervalMonths: number | null;
  firstKm: number | null;
  firstMonths: number | null;
  serviceCodes: readonly string[];
}

/** When an element was last done (TASK-069 will fill it from orders and «уже поменял»). */
export interface MaintenanceLastDone {
  elementId: string;
  atKm?: number;
  atMonths?: number;
}

export interface DueQuery {
  /** The car's mileage, km; unknown — `undefined`. */
  mileageKm?: number;
  /** The car's age in months (a lower bound from its year will do). */
  ageMonths?: number;
  /** «ТО-2»: the elements of this service, whatever the mileage. */
  serviceCode?: string;
  lastDone?: readonly MaintenanceLastDone[];
}

export type DueReason = "by_code" | "by_km" | "by_months" | "first";

export interface DueElement<Element extends MaintenanceElement> {
  element: Element;
  reason: DueReason;
  /** The mileage the element is due at; `null` — due by the code or by the age alone. */
  atKm: number | null;
  /** The age, months, it is due at by its months; `null` — not by months. */
  atMonths: number | null;
}

export interface DueAnswer<Element extends MaintenanceElement> {
  items: DueElement<Element>[];
  /** The service the listed elements are of, km; `null` — not by mileage. */
  serviceKm: number | null;
  /** The service after it, km («следующее ТО»); `null` — unknown. */
  nextServiceKm: number | null;
  /** `mileage_required` — neither a mileage nor a code was given. */
  reason: "mileage_required" | null;
}

/**
 * The next time something repeating every `interval` (first at `first`
 * when given) comes at or after `at`; `last` — when it was last done
 * (then the next one is a whole interval later, however early or late).
 */
function nextOccurrence(
  at: number,
  interval: number | null,
  first: number | null,
  last: number | undefined,
): { at: number; first: boolean } | null {
  if (last !== undefined) {
    if (interval === null) return null;
    return { at: last + interval, first: false };
  }
  if (first !== null && at <= first) return { at: first, first: true };
  if (interval === null) return null;
  // The multiples of the interval after the first time, at or after `at`.
  const from = Math.max(at, first === null ? 0 : first + 1);
  const k = Math.max(1, Math.ceil(from / interval));
  return { at: k * interval, first: false };
}

/**
 * The step of a plan: its shortest interval in km (months) — the next
 * service is the nearest multiple of it at or after the car's mileage
 * (age), a car at exactly a multiple is due at it (inclusive).
 */
function step(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null && value > 0);
  return known.length === 0 ? null : Math.min(...known);
}

function nextStep(at: number, by: number): number {
  return Math.max(1, Math.ceil(at / by)) * by;
}

/**
 * What a plan says is due (requirement 2):
 * - by a service code — the elements of that service;
 * - by the mileage — the next service is the nearest multiple of the
 *   plan's step at or after the mileage («20 000» at 20 000, «30 000» at
 *   20 001); an element is due when its own next time (its first time, or
 *   the next multiple of its interval) comes no earlier than the mileage
 *   and no later than that service;
 * - by the age (when known) — the same with months, «whichever first»;
 * - without a mileage and a code — nothing, «уточните пробег».
 * Ordered by the mileage it is due at, then by the plan's order.
 */
export function dueMaintenance<Element extends MaintenanceElement>(
  elements: readonly Element[],
  query: DueQuery,
): DueAnswer<Element> {
  const kmStep = step(elements.map((element) => element.intervalKm));
  const mileage = query.mileageKm;
  const serviceKm = mileage === undefined || kmStep === null ? null : nextStep(mileage, kmStep);
  const nextServiceKm = serviceKm === null || kmStep === null ? null : serviceKm + kmStep;
  const byPosition = (a: DueElement<Element>, b: DueElement<Element>) =>
    a.element.position - b.element.position;

  if (query.serviceCode !== undefined) {
    const code = query.serviceCode.trim().toLowerCase();
    return {
      items: elements
        .filter((element) => element.serviceCodes.some((own) => own.toLowerCase() === code))
        .map((element) => ({ element, reason: "by_code" as const, atKm: null, atMonths: null }))
        .sort(byPosition),
      serviceKm: null,
      nextServiceKm,
      reason: null,
    };
  }
  if (mileage === undefined) {
    return { items: [], serviceKm: null, nextServiceKm: null, reason: "mileage_required" };
  }

  const monthStep = step(elements.map((element) => element.intervalMonths));
  const age = query.ageMonths;
  const serviceMonths = age === undefined || monthStep === null ? null : nextStep(age, monthStep);
  const lastOf = new Map((query.lastDone ?? []).map((entry) => [entry.elementId, entry]));

  const items: DueElement<Element>[] = [];
  for (const element of elements) {
    const last = lastOf.get(element.id);
    let due: DueElement<Element> | null = null;
    if (serviceKm !== null) {
      const next = nextOccurrence(mileage, element.intervalKm, element.firstKm, last?.atKm);
      if (next && next.at <= serviceKm && (last !== undefined || next.at >= mileage)) {
        due = { element, reason: next.first ? "first" : "by_km", atKm: next.at, atMonths: null };
      }
    }
    if (!due && serviceMonths !== null && age !== undefined) {
      const next = nextOccurrence(age, element.intervalMonths, element.firstMonths, last?.atMonths);
      if (next && next.at <= serviceMonths && (last !== undefined || next.at >= age)) {
        due = {
          element,
          reason: next.first ? "first" : "by_months",
          atKm: null,
          atMonths: next.at,
        };
      }
    }
    if (due) items.push(due);
  }
  items.sort(
    (a, b) =>
      (a.atKm ?? serviceKm ?? 0) - (b.atKm ?? serviceKm ?? 0) ||
      a.element.position - b.element.position,
  );
  return { items, serviceKm, nextServiceKm, reason: null };
}

/**
 * The age of a car in full months as far as its year tells — a lower bound:
 * from the end of the year it was made to the start of the month now (a 2024
 * car in November 2026 is at least 22 months old: January 2025 … October
 * 2026; the month now is not over). Before the year ends — 0.
 */
export function ageMonthsFromYear(year: number, now: { year: number; month: number }): number {
  return Math.max(0, (now.year - year - 1) * 12 + now.month - 1);
}

/**
 * The lower bound of a car's age, full months (TASK-061.A; ARCHITECTURE 4.84
 * I949): by its year; without one — by the youngest car its generation can
 * be (`yearTo`; a generation still made — this year), so an element «by
 * age» is never due earlier than it is for every car it could be; nothing
 * known of the years — `null` (no element is due by age).
 */
export function maintenanceAgeMonths(
  car: { year: number | null; yearFrom: number | null; yearTo: number | null },
  now: { year: number; month: number },
): number | null {
  const year = car.year ?? car.yearTo ?? (car.yearFrom === null ? null : now.year);
  return year === null ? null : ageMonthsFromYear(year, now);
}

/** What keeps an element's intervals out (business rules); `null` — they are in order. */
export function maintenanceIntervalsProblem(element: {
  intervalKm: number | null;
  intervalMonths: number | null;
  firstKm: number | null;
  firstMonths: number | null;
}): "interval_required" | "km_range" | "months_range" | "first_km" | "first_months" | null {
  const { intervalKm, intervalMonths, firstKm, firstMonths } = element;
  if (intervalKm === null && intervalMonths === null) return "interval_required";
  if (intervalKm !== null && (intervalKm < MAINTENANCE_KM_MIN || intervalKm > MAINTENANCE_KM_MAX)) {
    return "km_range";
  }
  if (
    intervalMonths !== null &&
    (intervalMonths < MAINTENANCE_MONTHS_MIN || intervalMonths > MAINTENANCE_MONTHS_MAX)
  ) {
    return "months_range";
  }
  if (firstKm !== null && (intervalKm === null || firstKm < 1 || firstKm >= intervalKm)) {
    return "first_km";
  }
  if (
    firstMonths !== null &&
    (intervalMonths === null || firstMonths < 1 || firstMonths >= intervalMonths)
  ) {
    return "first_months";
  }
  return null;
}
