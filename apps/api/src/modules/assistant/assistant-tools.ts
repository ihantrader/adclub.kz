import { Inject, Injectable } from "@nestjs/common";
import {
  ASSISTANT_QUESTION_OPTIONS_MAX,
  assistantIntentSchema,
  showcaseAttributeFilterSchema,
  type CatalogLanguage,
  type CompatibilityVehicle,
  type ResolvedCompatibilityVehicle,
  type ShowcaseListItem,
  type ShowcaseListQuery,
} from "@adclub/contracts";
import { z } from "zod";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import type { AssistantToolSpec } from "../ai";
import { CatalogReadService } from "../catalog";
import { MaintenanceAnswers } from "../maintenance";
import { CatalogSearchService, ShowcaseService, type Viewer } from "../showcase";
import { enginesOf } from "./assistant-car";

/**
 * The tools of the assistant (TASK-062; ARCHITECTURE 11.1, 4.85). The model
 * finds nothing by itself: every item it may name comes from one of these,
 * and each of them is the catalog's own code — the search
 * (`CatalogSearchService.search`), the list of a subcategory
 * (`ShowcaseService.list`), the card (`ShowcaseService.card`), the
 * maintenance plan (`MaintenanceAnswers.answer`), the tree
 * (`CatalogReadService.tree`) — run with the car, the city and the viewer
 * of the request. So what the model sees is what the catalog shows this
 * person, cut to what the model needs (ids, names, characteristics, «от N ₸»):
 * no supplier, no phone, no address ever reaches it.
 *
 * The arguments are the model's and untrusted: each tool checks them with
 * its own zod schema, and a wrong one is an error the model is told about,
 * never a 500.
 */

const uuid = z.uuid();

export const searchCatalogArgs = z
  .object({
    query: z.string().trim().min(2).max(100).optional(),
    categoryId: uuid.optional(),
    attributes: z.array(showcaseAttributeFilterSchema).max(20).optional(),
    engineId: uuid.optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .refine((args) => args.query !== undefined || args.categoryId !== undefined, {
    message: "Give a query, a categoryId, or both",
  });

export const getItemArgs = z.object({ itemId: uuid });

export const getMaintenancePlanArgs = z.object({
  mileageKm: z.number().int().min(0).max(2_000_000).optional(),
  serviceCode: z.string().trim().min(1).max(20).optional(),
});

export const listCategoriesArgs = z.object({
  kind: z.enum(["goods", "services"]).optional(),
  categoryId: uuid.optional(),
});

export const askUserArgs = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(40)).max(ASSISTANT_QUESTION_OPTIONS_MAX).optional(),
  intent: assistantIntentSchema,
});

export const proposeArgs = z.object({
  text: z.string().max(3000),
  intent: assistantIntentSchema,
  itemIds: z.array(z.string()).max(30).optional(),
  groups: z
    .array(
      z.object({ title: z.string().trim().min(1).max(80), itemIds: z.array(z.string()).max(10) }),
    )
    .max(15)
    .optional(),
  notes: z.string().max(500).optional(),
});

export type AskUserArgs = z.infer<typeof askUserArgs>;
export type ProposeArgs = z.infer<typeof proposeArgs>;

/** The tools that end a turn. */
export const FINAL_TOOLS = ["ask_user", "propose"] as const;

/** The JSON Schema of a tool's arguments, as the provider takes it. */
/**
 * The JSON Schema of a tool's arguments, as every provider takes it: the
 * subset function calling agrees on (TASK-062 — Gemini refuses a whole
 * request with `pattern`, `format: uuid` or `additionalProperties` in a
 * tool). Those are dropped here; a uuid is said in the description instead,
 * and the server checks the arguments with the full zod schema anyway.
 */
export function parametersOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  const portable = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(portable);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "pattern" || key === "additionalProperties" || key === "$schema") continue;
      if (key === "format") {
        if (value === "uuid") out.description = "An id (uuid) returned by a tool";
        continue;
      }
      out[key] = portable(value);
    }
    return out;
  };
  return portable(json) as Record<string, unknown>;
}

const intentText =
  "pick_by_params — an item by its parameters; maintenance — scheduled service (ТО); symptom — a description of trouble (a noise, a vibration); other — not about the club's car goods and services.";

/**
 * The tools as the model is told about them: always the same, in the same
 * order, so the start of every request is the same and the provider can
 * cache it (ARCHITECTURE 11.5).
 */
export const ASSISTANT_TOOLS: readonly AssistantToolSpec[] = [
  {
    name: "search_catalog",
    description:
      "Search the club's catalog for the person's car and city (already applied): by words or an article (query), and/or within one subcategory (categoryId) with filters by its characteristics (attributes: [{attributeId, optionIds} | {attributeId, min, max} | {attributeId, value}] — ids from list_categories with categoryId, or from a maintenance plan). Only items on sale now are returned: id, name, brand, article, key characteristics, compatibility with the car, the lowest price and the number of offers. engineId — when the result says the engine is needed, one of the engines it lists.",
    parameters: parametersOf(searchCatalogArgs),
  },
  {
    name: "get_item",
    description:
      "One item of the catalog by its id (from search_catalog): all its characteristics, its compatibility with the car, the summary of its offers and its analogs on sale.",
    parameters: parametersOf(getItemArgs),
  },
  {
    name: "get_maintenance_plan",
    description:
      "What the car is due by its maintenance plan at a mileage (mileageKm) or a service code («ТО-2»): the works, and for each the subcategory (categoryId), the filters (attributes) to pass to search_catalog and how many items are on sale.",
    parameters: parametersOf(getMaintenancePlanArgs),
  },
  {
    name: "list_categories",
    description:
      "The catalog's tree: the nodes and their subcategories with ids and codes (kind — goods or services). With categoryId of a subcategory — its characteristics that filter (ids, the options of lists with their ids, units).",
    parameters: parametersOf(listCategoriesArgs),
  },
  {
    name: "ask_user",
    description: `Ends the turn with one short clarifying question and up to ${String(ASSISTANT_QUESTION_OPTIONS_MAX)} short quick replies (options). intent: ${intentText}`,
    parameters: parametersOf(askUserArgs),
  },
  {
    name: "propose",
    description: `Ends the turn with the answer: a short plain text (no item names, prices or links — the server shows the items as cards) and the ids of the items to show (itemIds), or for a maintenance plan groups [{title, itemIds}] (an empty group — nothing on sale for that work). Only ids returned by the tools in this dialog. intent: ${intentText}`,
    parameters: parametersOf(proposeArgs),
  },
];

/** The car, the city and the viewer every tool of a turn runs with. */
export interface ToolContext {
  vehicle: CompatibilityVehicle;
  resolved: ResolvedCompatibilityVehicle;
  cityId: string | null;
  viewer: Viewer;
  lang: CatalogLanguage;
}

/** What a tool gave: the JSON for the model, the same for the record, and the item ids it returned. */
export interface ToolOutcome {
  content: string;
  result: unknown;
  foundIds: string[];
}

/** A tool's own refusal: the model is told why and may try again. */
class ToolError extends Error {}

/** The car as the catalog's queries take it. */
export function vehicleQueryOf(vehicle: CompatibilityVehicle): Partial<ShowcaseListQuery> {
  return {
    ...(vehicle.modificationId ? { vehicleModificationId: vehicle.modificationId } : {}),
    ...(vehicle.makeId ? { vehicleMakeId: vehicle.makeId } : {}),
    ...(vehicle.modelId ? { vehicleModelId: vehicle.modelId } : {}),
    ...(vehicle.generationId ? { vehicleGenerationId: vehicle.generationId } : {}),
    ...(vehicle.bodyTypeId ? { vehicleBodyTypeId: vehicle.bodyTypeId } : {}),
    ...(vehicle.engineId ? { vehicleEngineId: vehicle.engineId } : {}),
    ...(vehicle.transmissionTypeId
      ? { vehicleTransmissionTypeId: vehicle.transmissionTypeId }
      : {}),
    ...(vehicle.driveTypeId ? { vehicleDriveTypeId: vehicle.driveTypeId } : {}),
    ...(vehicle.year !== undefined ? { vehicleYear: vehicle.year } : {}),
  };
}

/** A row of a list or of the search as the model sees it. */
function compactItem(item: ShowcaseListItem, category: { id: string; name: string }) {
  return {
    id: item.id,
    name: item.name.text,
    brand: item.brand?.name ?? null,
    article: item.article,
    categoryId: category.id,
    category: category.name,
    attributes: item.keyAttributes.map((value) => `${value.name.text}: ${value.display.text}`),
    compatibility: item.compatibility.mark ?? item.compatibility.result ?? "not_specified",
    ...(item.compatibility.missing.length > 0 ? { needs: item.compatibility.missing } : {}),
    priceFrom: item.offers.minPrice,
    offers: item.offers.count,
    inCity: item.offers.inCity,
    inStock: item.offers.inStock,
  };
}

@Injectable()
export class AssistantTools {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CatalogSearchService) private readonly search: CatalogSearchService,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
    @Inject(MaintenanceAnswers) private readonly maintenance: MaintenanceAnswers,
    @Inject(CatalogReadService) private readonly catalog: CatalogReadService,
  ) {}

  /** Runs one lookup tool; a wrong call is an error for the model (`{ error }`), never a throw. */
  async run(name: string, rawArguments: string, context: ToolContext): Promise<ToolOutcome> {
    let args: unknown;
    try {
      args = JSON.parse(rawArguments) as unknown;
    } catch {
      return this.error("The arguments are not JSON");
    }
    try {
      switch (name) {
        case "search_catalog":
          return await this.searchCatalog(this.parse(searchCatalogArgs, args), context);
        case "get_item":
          return await this.getItem(this.parse(getItemArgs, args), context);
        case "get_maintenance_plan":
          return await this.maintenancePlan(this.parse(getMaintenancePlanArgs, args), context);
        case "list_categories":
          return await this.categories(this.parse(listCategoriesArgs, args), context);
        default:
          return this.error(`No tool ${name}`);
      }
    } catch (error) {
      if (error instanceof ToolError) return this.error(error.message);
      // The catalog refusing a request of the model (a hidden subcategory,
      // an inconsistent engine, a query too short) is the model's mistake.
      if (error instanceof ApiException && error.status < 500) {
        return this.error(`${error.code}: ${error.message}`);
      }
      throw error;
    }
  }

  private parse<T>(schema: z.ZodType<T>, args: unknown): T {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      throw new ToolError(`Wrong arguments — ${issues.join("; ")}`);
    }
    return parsed.data;
  }

  private error(message: string): ToolOutcome {
    const result = { error: message };
    return { content: JSON.stringify(result), result, foundIds: [] };
  }

  private outcome(result: unknown, foundIds: string[]): ToolOutcome {
    return { content: JSON.stringify(result), result, foundIds };
  }

  private async searchCatalog(
    args: z.infer<typeof searchCatalogArgs>,
    context: ToolContext,
  ): Promise<ToolOutcome> {
    let vehicle = context.vehicle;
    if (args.engineId) {
      const engines = await enginesOf(this.database.db, context.resolved);
      if (!engines.some((engine) => engine.id === args.engineId)) {
        throw new ToolError("engineId is not an engine of this car's model");
      }
      vehicle = { ...vehicle, engineId: args.engineId };
    }
    const limit = args.limit ?? 5;
    const common = {
      ...vehicleQueryOf(vehicle),
      ...(context.cityId ? { cityId: context.cityId } : {}),
      ...(args.attributes && args.attributes.length > 0 ? { attributes: args.attributes } : {}),
      limit,
    };
    let items: ReturnType<typeof compactItem>[];
    let extra: Record<string, unknown>;
    if (args.query) {
      const found = await this.search.search(
        { q: args.query, ...common, ...(args.categoryId ? { categoryId: args.categoryId } : {}) },
        context.viewer,
        context.lang,
      );
      items = found.items.map((item) =>
        compactItem(item, { id: item.category.id, name: item.category.name.text }),
      );
      extra = {
        total: found.total,
        ...(found.empty ? { empty: found.empty } : {}),
        ...(found.usedQuery ? { readAs: found.usedQuery } : {}),
        ...(found.categories.length > 0
          ? {
              subcategories: found.categories.map((entry) => ({
                id: entry.id,
                name: entry.name.text,
              })),
            }
          : {}),
      };
    } else {
      const list = await this.showcase.list(
        args.categoryId!,
        { ...common, sort: "recommended" },
        context.viewer,
        context.lang,
      );
      const category = { id: list.category.id, name: list.category.name.text };
      items = list.items.map((item) => compactItem(item, category));
      extra = { total: list.total, ...(list.empty ? { empty: list.empty } : {}) };
    }
    // «Уточните двигатель»: the engines this car can have, to ask about (TASK-062).
    const needsEngine = !args.engineId && items.some((item) => item.needs?.includes("engine"));
    const engines = needsEngine ? await enginesOf(this.database.db, context.resolved) : [];
    return this.outcome(
      { items, ...extra, ...(engines.length > 0 ? { engineNeeded: true, engines } : {}) },
      items.map((item) => item.id),
    );
  }

  private async getItem(
    args: z.infer<typeof getItemArgs>,
    context: ToolContext,
  ): Promise<ToolOutcome> {
    const card = await this.showcase.card(
      args.itemId,
      { ...vehicleQueryOf(context.vehicle), ...(context.cityId ? { cityId: context.cityId } : {}) },
      context.viewer,
      context.lang,
    );
    const prices = card.offers.map((offer) => offer.price);
    const result = {
      id: card.item.id,
      name: card.item.name.text,
      brand: card.item.brand?.name ?? null,
      article: card.item.article,
      categoryId: card.item.category.id,
      category: card.item.category.name.text,
      attributes: card.item.attributes.map((value) => `${value.name.text}: ${value.display.text}`),
      compatibility: card.compatibility.mark ?? card.compatibility.result ?? "not_specified",
      ...(card.compatibility.missing.length > 0 ? { needs: card.compatibility.missing } : {}),
      offers: card.offers.length,
      priceFrom: prices.length > 0 ? Math.min(...prices) : null,
      inCity: card.offers.some((offer) => offer.inCity),
      inStock: card.offers.some((offer) => offer.availability === "in_stock"),
      analogs: card.analogs.slice(0, 5).map((analog) => ({
        id: analog.id,
        name: analog.name.text,
        brand: analog.brand?.name ?? null,
        priceFrom: analog.offers.minPrice,
      })),
    };
    return this.outcome(result, [card.item.id, ...result.analogs.map((analog) => analog.id)]);
  }

  private async maintenancePlan(
    args: z.infer<typeof getMaintenancePlanArgs>,
    context: ToolContext,
  ): Promise<ToolOutcome> {
    const vehicle = vehicleQueryOf(context.vehicle);
    const answer = await this.maintenance.answer(
      {
        ...vehicle,
        ...(context.cityId ? { cityId: context.cityId } : {}),
        ...(args.mileageKm !== undefined ? { mileageKm: args.mileageKm } : {}),
        ...(args.serviceCode ? { serviceCode: args.serviceCode } : {}),
      },
      context.viewer,
      context.lang,
    );
    const result = {
      plan: answer.plan !== null,
      ...(answer.noPlan ? { noPlan: answer.noPlan, missing: answer.missing } : {}),
      ...(answer.reason ? { reason: answer.reason } : {}),
      serviceCodes: answer.plan?.serviceCodes ?? [],
      serviceKm: answer.serviceKm,
      nextServiceKm: answer.nextServiceKm,
      items: answer.items.map((item) => ({
        title: item.title.text,
        kind: item.kind,
        reason: item.reason,
        atKm: item.atKm,
        quantity: item.quantity,
        catalog: {
          count: item.catalog.count,
          priceFrom: item.catalog.minPrice,
          ...(item.catalog.cityRequired ? { cityRequired: true } : {}),
          ...(item.catalog.unavailable ? { unavailable: true } : {}),
          categoryId: item.catalog.categoryId,
          attributes: item.catalog.filters,
          ...(item.catalog.itemIds.length > 0 ? { itemIds: item.catalog.itemIds } : {}),
        },
      })),
    };
    // The items named by a rule are the plan's own and found by it (an id the catalog gave).
    return this.outcome(
      result,
      answer.items.flatMap((item) => item.catalog.itemIds),
    );
  }

  private async categories(
    args: z.infer<typeof listCategoriesArgs>,
    context: ToolContext,
  ): Promise<ToolOutcome> {
    if (args.categoryId) {
      const described = await this.catalog.attributes(args.categoryId, context.lang);
      return this.outcome(
        {
          attributes: described.attributes
            .filter((entry) => entry.isFilterable)
            .map((entry) => ({
              id: entry.id,
              code: entry.code,
              name: entry.name.text,
              type: entry.valueType,
              ...(entry.unit ? { unit: entry.unit.text } : {}),
              ...(entry.options.length > 0
                ? {
                    options: entry.options.map((option) => ({
                      id: option.id,
                      name: option.name.text,
                    })),
                  }
                : {}),
            })),
        },
        [],
      );
    }
    const tree = await this.catalog.tree(context.lang);
    return this.outcome(
      {
        categories: tree.categories
          .filter((node) => args.kind === undefined || node.kind === args.kind)
          .map((node) => ({
            id: node.id,
            code: node.code,
            name: node.name.text,
            kind: node.kind,
            subcategories: node.children.map((child) => ({
              id: child.id,
              code: child.code,
              name: child.name.text,
            })),
          })),
      },
      [],
    );
  }
}
