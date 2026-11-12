import { Inject, Injectable } from "@nestjs/common";
import type {
  AssistantCard,
  AssistantGroup,
  AssistantIntent,
  CatalogLanguage,
} from "@adclub/contracts";
import { claimsDiagnosis, cleanAssistantText, mileageInText } from "@adclub/domain";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { catalogItem, category } from "../catalog";
import { ShowcaseService } from "../showcase";
import { AppSettings } from "../settings";
import { NEUTRAL_TEXT, NOT_FOUND_TEXT, NOT_PICKED_TEXT, OFF_TOPIC_TEXT } from "./assistant-texts";
import {
  vehicleQueryOf,
  type AskUserArgs,
  type ProposeArgs,
  type ToolContext,
} from "./assistant-tools";
import type { StoredReply } from "./assistant-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The top-level nodes whose items tell of trouble with the car (TASK-062):
 * an answer with cards of their subcategories and no intent of the model
 * is treated as a symptom — the disclaimer is set.
 */
const SYMPTOM_NODES = new Set(["brakes", "suspension", "engine"]);

/** The page of a subcategory's list the cards are checked in (the list's own largest page). */
export const CARDS_PAGE = 50;

/** How the turn ended, as the pipeline hands it over. */
export type TurnEnd =
  | { kind: "ask"; args: AskUserArgs }
  | { kind: "propose"; args: ProposeArgs }
  /** The model answered with text and called nothing. */
  | { kind: "text"; text: string | null }
  /** The tool calls ran out (`assistant_max_tool_calls`). */
  | { kind: "exhausted" };

/** The answer of a turn as it is shown and stored. */
export interface BuiltReply {
  kind: "answer" | "question" | "off_topic";
  intent: AssistantIntent | null;
  text: string;
  reply: StoredReply;
  /** The ids of the cards shown. */
  itemIds: string[];
  /** How many item ids of the model were dropped: never returned by a tool, or not on sale now. */
  dropped: number;
}

const EMPTY: Omit<StoredReply, "question"> = {
  cards: [],
  groups: [],
  total: null,
  orderEachItem: false,
  notOnPlatform: [],
  disclaimer: null,
  mileageSuggestion: null,
  notFound: false,
  unavailable: null,
};

/**
 * The answer of a turn (TASK-062; ARCHITECTURE 4.85, 11.1 points 4–5):
 * grounding and the server's own parts.
 *
 * - **Grounding.** An item id of the model counts only when a tool returned
 *   it in this dialog, and is shown only when the list of its subcategory —
 *   `ShowcaseService.list`, the catalog's own code, with the car, the city
 *   and the viewer — shows it now; the card is that list's row. An id
 *   invented, of another dialog, or of an offer withdrawn since is dropped
 *   and counted. Nothing is ever made up for a model that proposed nothing.
 * - **Text.** The model's text is only text: links, phones, e-mails and
 *   markup are taken off (`cleanAssistantText`), a claim of a diagnosis is
 *   replaced by a neutral line, and an answer with no card left says T-AI-03.
 * - **Symptom.** The disclaimer (`assistant_symptom_disclaimer`) and — when
 *   the city sells it — the card of the diagnostics service
 *   (`assistant_diagnostics_category`) are the server's, whatever the model
 *   wrote.
 */
@Injectable()
export class AssistantAnswers {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async build(input: {
    end: TurnEnd;
    found: ReadonlySet<string>;
    context: ToolContext;
    userText: string;
    mileageKm: number | null;
  }): Promise<BuiltReply> {
    const { end, context } = input;
    const lang = context.lang;
    const km = mileageInText(input.userText);
    const mileageSuggestion = km !== null && km !== input.mileageKm ? { km } : null;

    if (end.kind === "ask") {
      const question = cleanAssistantText(end.args.question).text;
      const options = (end.args.options ?? [])
        .map((option) => cleanAssistantText(option, 40))
        .filter((option) => option.droppedSentences === 0 && option.text !== "")
        .map((option) => option.text);
      const symptom = end.args.intent === "symptom";
      return {
        kind: "question",
        intent: end.args.intent,
        text: question !== "" && !claimsDiagnosis(question) ? question : NEUTRAL_TEXT[lang],
        reply: {
          ...EMPTY,
          question: { options: [...new Set(options)] },
          disclaimer: symptom ? await this.disclaimer(lang) : null,
          mileageSuggestion,
        },
        itemIds: [],
        dropped: 0,
      };
    }

    if (end.kind === "propose" && end.args.intent === "other") {
      return {
        kind: "off_topic",
        intent: "other",
        text: OFF_TOPIC_TEXT[lang],
        reply: { ...EMPTY, question: null },
        itemIds: [],
        // Not grounding: an answer out of topic shows no item at all, so
        // nothing the model named counts as dropped (TASK-063).
        dropped: 0,
      };
    }

    if (end.kind === "exhausted" || end.kind === "text") {
      const text =
        end.kind === "text" && end.text ? cleanAssistantText(end.text).text : NOT_PICKED_TEXT[lang];
      return {
        kind: "answer",
        intent: null,
        text: text === "" || claimsDiagnosis(text) ? NOT_PICKED_TEXT[lang] : text,
        reply: { ...EMPTY, question: null, notFound: end.kind === "exhausted", mileageSuggestion },
        itemIds: [],
        dropped: 0,
      };
    }

    // The final answer: grounding first.
    const args = end.args;
    const named = [
      ...new Set(
        [...(args.itemIds ?? []), ...(args.groups ?? []).flatMap((group) => group.itemIds)].map(
          (id) => id.toLowerCase(),
        ),
      ),
    ];
    const allowed = named.filter((id) => UUID.test(id) && input.found.has(id));
    const cards = await this.cards(allowed, context);
    const dropped = named.length - cards.size;

    const groups: AssistantGroup[] = (args.groups ?? []).map((group) => {
      const itemIds = [...new Set(group.itemIds.map((id) => id.toLowerCase()))].filter((id) =>
        cards.has(id),
      );
      const prices = itemIds.map((id) => cards.get(id)!.offers.minPrice);
      return {
        title: cleanAssistantText(group.title, 80).text,
        itemIds,
        minPrice: prices.length > 0 ? Math.min(...prices) : null,
      };
    });
    const ordered = named.filter((id) => cards.has(id)).map((id) => cards.get(id)!);
    const symptom =
      args.intent === "symptom" ||
      (args.intent !== "pick_by_params" &&
        args.intent !== "maintenance" &&
        (await this.touchesTrouble(ordered.map((card) => card.category.id))));
    const shown = [...ordered];
    if (symptom) {
      const diagnostics = await this.diagnosticsCard(context);
      if (diagnostics && !cards.has(diagnostics.id)) shown.push(diagnostics);
    }
    const priced = groups.filter((group) => group.minPrice !== null);
    const notFound = ordered.length === 0;
    let text = cleanAssistantText(args.text).text;
    if (claimsDiagnosis(text)) text = NEUTRAL_TEXT[lang];
    if (notFound) text = NOT_FOUND_TEXT[lang];
    if (text === "") text = NEUTRAL_TEXT[lang];
    return {
      kind: "answer",
      intent: args.intent,
      text,
      reply: {
        question: null,
        cards: shown,
        groups,
        total:
          priced.length > 0
            ? { minPrice: priced.reduce((sum, group) => sum + group.minPrice!, 0), currency: "KZT" }
            : null,
        orderEachItem: groups.length > 0 || ordered.length > 1,
        notOnPlatform: groups.filter((group) => group.itemIds.length === 0).map((g) => g.title),
        disclaimer: symptom ? await this.disclaimer(lang) : null,
        mileageSuggestion,
        notFound,
        unavailable: null,
      },
      itemIds: shown.map((card) => card.id),
      dropped,
    };
  }

  /**
   * The cards of these items as the list of each one's subcategory shows them
   * now for this car, city and viewer (`ShowcaseService.list` kept to them):
   * an item the list doesn't show — no offer on sale, does not fit (D-029), a
   * service without the city, a hidden subcategory — has no card.
   */
  async cards(ids: readonly string[], context: ToolContext): Promise<Map<string, AssistantCard>> {
    const cards = new Map<string, AssistantCard>();
    if (ids.length === 0) return cards;
    const rows = await this.database.db
      .select({ id: catalogItem.id, categoryId: catalogItem.categoryId })
      .from(catalogItem)
      .where(inArray(catalogItem.id, [...ids]));
    const byCategory = new Map<string, string[]>();
    for (const row of rows) {
      byCategory.set(row.categoryId, [...(byCategory.get(row.categoryId) ?? []), row.id]);
    }
    const query = {
      ...vehicleQueryOf(context.vehicle),
      ...(context.cityId ? { cityId: context.cityId } : {}),
      sort: "cheaper" as const,
      limit: CARDS_PAGE,
    };
    for (const [categoryId, itemIds] of byCategory) {
      // Every named item is checked: the list's page is CARDS_PAGE, so more
      // of one subcategory go in pages of it (TASK-063).
      for (let start = 0; start < itemIds.length; start += CARDS_PAGE) {
        let list;
        try {
          list = await this.showcase.list(categoryId, query, context.viewer, context.lang, {
            itemIds: itemIds.slice(start, start + CARDS_PAGE),
          });
        } catch (error) {
          if (error instanceof ApiException && error.status === 404) break;
          throw error;
        }
        for (const item of list.items) {
          cards.set(item.id, {
            ...item,
            category: { id: list.category.id, kind: list.category.kind, name: list.category.name },
          });
        }
      }
    }
    return cards;
  }

  /** The diagnostics service of the city for the car, when one is sold (`assistant_diagnostics_category`). */
  private async diagnosticsCard(context: ToolContext): Promise<AssistantCard | null> {
    const code = await this.settings.get("assistant_diagnostics_category");
    if (!code || !context.cityId) return null;
    const [row] = await this.database.db
      .select({ id: category.id })
      .from(category)
      .where(and(eq(category.code, code), eq(category.level, 2), eq(category.status, "active")));
    if (!row) return null;
    try {
      const list = await this.showcase.list(
        row.id,
        {
          ...vehicleQueryOf(context.vehicle),
          cityId: context.cityId,
          sort: "recommended",
          limit: 1,
        },
        context.viewer,
        context.lang,
      );
      const item = list.items[0];
      return item
        ? {
            ...item,
            category: { id: list.category.id, kind: list.category.kind, name: list.category.name },
          }
        : null;
    } catch (error) {
      if (error instanceof ApiException && error.status === 404) return null;
      throw error;
    }
  }

  /** Whether any of these subcategories lies under the brakes, the suspension or the engine. */
  private async touchesTrouble(categoryIds: readonly string[]): Promise<boolean> {
    if (categoryIds.length === 0) return false;
    const parent = alias(category, "parent");
    const rows = await this.database.db
      .select({ code: parent.code })
      .from(category)
      .innerJoin(parent, eq(parent.id, category.parentId))
      .where(inArray(category.id, [...categoryIds]));
    return rows.some((row) => SYMPTOM_NODES.has(row.code));
  }

  private async disclaimer(lang: CatalogLanguage): Promise<string> {
    const texts = await this.settings.get("assistant_symptom_disclaimer");
    return texts[lang];
  }
}
