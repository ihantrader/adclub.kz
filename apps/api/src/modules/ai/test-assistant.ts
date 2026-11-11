import type { AiTestMode } from "../../config";
import type { AssistantChatMessage, AssistantStepInput, AssistantStepOutput } from "./ai-gateway";

/**
 * The stand-in assistant of the test provider (TASK-062): for development,
 * tests and CI, with no call anywhere. It plays the three scenarios of
 * PRODUCT 8.3 and the refusals by the words of the last message, and calls
 * the very tools a real model would, reading what they returned — so the
 * pipeline, the tools, grounding and the checks of the server run exactly as
 * with a real model:
 *
 * - «масло» / «oil» / «май» — `search_catalog` «масло», then `ask_user` about
 *   the volume of the can (the volumes of what was found), then — the answer
 *   «4 л» — `propose` with the found oils of that volume;
 * - «ТО-2», «ТО», «maintenance» — `get_maintenance_plan` (the mileage and the
 *   code of the message), `search_catalog` by the rule of every element that
 *   has something on sale, `propose` with a group per element; without a
 *   mileage or a code — `ask_user` about the mileage;
 * - «скрипит», «стук», «squeak», «сықыр» — `ask_user` (front or rear), then
 *   `search_catalog` «колодки» and `propose` with the intent `symptom`;
 *   «диагноз» anywhere in the dialog — the text claims one (the server
 *   replaces it); «телефон» / «контакт» — the text carries a phone and a
 *   link (the server drops those sentences);
 * - «погода», «weather», «анекдот» — `propose` with the intent `other`;
 * - «выдумай» (`TEST_ASSISTANT_INVENT_MARKER`) — `search_catalog` «масло»,
 *   then `propose` with what was found **and** an id that does not exist and
 *   every id written in the message (an item of the catalog the tools never
 *   returned) — what grounding must drop;
 * - anything else — `search_catalog` by the message and `propose` with it.
 *
 * `AI_TEST_MODE=invalid_output` — every step calls `search_catalog` with
 * arguments that are not JSON: the tool refuses each, and the turn ends at
 * `assistant_max_tool_calls` with «не удалось подобрать».
 */

/** The word of a message that makes the stand-in invent items (grounding). */
export const TEST_ASSISTANT_INVENT_MARKER = "выдумай";

/** An id no item has: the stand-in invents it. */
export const TEST_ASSISTANT_INVENTED_ID = "00000000-0000-4000-8000-0000000000aa";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

interface ToolResult {
  name: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}

interface FoundItem {
  id: string;
  name?: string;
  categoryId?: string;
  attributes?: string[];
}

interface PlanItem {
  title?: string;
  catalog?: {
    count?: number | null;
    categoryId?: string | null;
    attributes?: unknown[];
  };
}

let calls = 0;

function call(
  name: string,
  args: Record<string, unknown> | string,
): AssistantStepOutput["toolCalls"][number] {
  calls += 1;
  return {
    id: `test-call-${String(calls)}`,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

function step(...toolCalls: AssistantStepOutput["toolCalls"]): AssistantStepOutput {
  return { text: null, toolCalls };
}

function parse(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The results of the tools called in this turn, with the call that asked for each. */
function resultsOf(turn: readonly AssistantChatMessage[]): ToolResult[] {
  const asked = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  const results: ToolResult[] = [];
  for (const message of turn) {
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls) {
        asked.set(toolCall.id, { name: toolCall.name, arguments: parse(toolCall.arguments) });
      }
    } else if (message.role === "tool") {
      const made = asked.get(message.toolCallId);
      if (made) results.push({ ...made, result: parse(message.content) });
    }
  }
  return results;
}

function foundItems(results: readonly ToolResult[]): FoundItem[] {
  return results.flatMap((entry) =>
    entry.name === "search_catalog" && Array.isArray(entry.result.items)
      ? (entry.result.items as FoundItem[])
      : [],
  );
}

const VOLUME = /(\d+(?:[.,]\d+)?)\s*л(?![\p{L}])/giu;

function volumesOf(item: FoundItem): string[] {
  const text = [item.name ?? "", ...(item.attributes ?? [])].join(" ");
  return [...text.matchAll(VOLUME)].map((match) => `${match[1]!.replace(",", ".")} л`);
}

function mileageOf(text: string): number | undefined {
  const match = /(\d{1,3}(?:[ .]\d{3})+|\d+)\s*(к|k|тыс|мың)?/iu.exec(
    text.replace(/то[-\s]?\d+/giu, ""),
  );
  if (!match) return undefined;
  const value = Number(match[1]!.replace(/[ .]/gu, "")) * (match[2] ? 1000 : 1);
  return value >= 100 ? value : undefined;
}

export function testAssistantStep(
  input: AssistantStepInput,
  mode: AiTestMode,
): AssistantStepOutput {
  const messages = input.messages;
  // The person's last message — not a note of the app to the model («(The app, not the person:) …»).
  const lastUser = messages
    .map((message) =>
      message.role === "user" && !message.content.startsWith("(The app") ? "person" : "",
    )
    .lastIndexOf("person");
  const said = lastUser >= 0 ? (messages[lastUser] as { content: string }).content : "";
  const text = said.toLowerCase();
  const turn = messages.slice(lastUser + 1);
  const results = resultsOf(turn);
  const found = foundItems(results);
  const searched = results.some((entry) => entry.name === "search_catalog");
  const history = messages.slice(0, Math.max(0, lastUser));
  // The last turn before this one, as the pipeline replays it: the closing call (`assistant-prompt.ts`).
  const lastClose = [...history]
    .reverse()
    .flatMap((message) => (message.role === "assistant" ? [...message.toolCalls].reverse() : []))
    .find((call) => call.name === "ask_user" || call.name === "propose");
  const askedIntent =
    lastClose?.name === "ask_user"
      ? ((parse(lastClose.arguments).intent as string | undefined) ?? null)
      : null;
  const dialogText = messages
    .filter((message) => message.role === "user")
    .map((message) => (message as { content: string }).content.toLowerCase())
    .join(" ");

  if (mode === "invalid_output") {
    return step(call("search_catalog", '{"query": "масло", "limit": '));
  }

  // Grounding: what was found and what was not.
  if (text.includes(TEST_ASSISTANT_INVENT_MARKER) || text.includes("invent")) {
    if (!searched) return step(call("search_catalog", { query: "масло", limit: 5 }));
    const written = [...said.matchAll(UUID)].map((match) => match[0].toLowerCase());
    return step(
      call("propose", {
        intent: "pick_by_params",
        text: "Вот что подойдёт.",
        itemIds: [
          ...found.slice(0, 2).map((item) => item.id),
          TEST_ASSISTANT_INVENTED_ID,
          ...written,
        ],
      }),
    );
  }

  if (/погод|weather|ауа рай|анекдот|joke/u.test(text)) {
    return step(call("propose", { intent: "other", text: "Сегодня солнечно, +25." }));
  }

  if (
    /(?:^|[^\p{L}])то(?:[-\s]?\d|$|[^\p{L}])|техобслуж|maintenance|регламент/u.test(text) ||
    askedIntent === "maintenance"
  ) {
    const plan = results.find((entry) => entry.name === "get_maintenance_plan");
    const code = /то[-\s]?(\d+)/iu.exec(said)?.[1];
    const km = mileageOf(said);
    if (!plan) {
      return step(
        call("get_maintenance_plan", {
          ...(km !== undefined ? { mileageKm: km } : {}),
          ...(code ? { serviceCode: `ТО-${code}` } : {}),
        }),
      );
    }
    const items = Array.isArray(plan.result.items) ? (plan.result.items as PlanItem[]) : [];
    if (items.length === 0) {
      return step(
        call("ask_user", {
          intent: "maintenance",
          question: "Какой сейчас пробег?",
          options: ["10 000 км", "20 000 км", "30 000 км"],
        }),
      );
    }
    const sold = items.filter(
      (item) => (item.catalog?.count ?? 0) > 0 && typeof item.catalog?.categoryId === "string",
    );
    if (!searched && sold.length > 0) {
      return step(
        ...sold.map((item) =>
          call("search_catalog", {
            categoryId: item.catalog!.categoryId,
            ...(item.catalog!.attributes && item.catalog!.attributes.length > 0
              ? { attributes: item.catalog!.attributes }
              : {}),
            limit: 3,
          }),
        ),
      );
    }
    const used = new Set<string>();
    return step(
      call("propose", {
        intent: "maintenance",
        text: "По регламенту на этот пробег положено:",
        groups: items.map((item) => {
          const match = found.find(
            (entry) => entry.categoryId === item.catalog?.categoryId && !used.has(entry.id),
          );
          if (match) used.add(match.id);
          return { title: item.title ?? "", itemIds: match ? [match.id] : [] };
        }),
      }),
    );
  }

  if (/скрип|стук|скреж|squeak|grind|сықыр|шум/u.test(text) || askedIntent === "symptom") {
    if (askedIntent !== "symptom") {
      return step(
        call("ask_user", {
          intent: "symptom",
          question: "Звук спереди или сзади?",
          options: ["Спереди", "Сзади", "Не знаю"],
        }),
      );
    }
    if (!searched) return step(call("search_catalog", { query: "колодки", limit: 5 }));
    const claim = /диагноз|diagnos/u.test(dialogText);
    return step(
      call("propose", {
        intent: "symptom",
        text: claim
          ? "Диагноз: у вас точно неисправны передние колодки."
          : "Возможные варианты — тормозные колодки под ваш автомобиль.",
        itemIds: found.slice(0, 3).map((item) => item.id),
      }),
    );
  }

  if (/масл|oil|май/u.test(text) || askedIntent === "pick_by_params") {
    if (!searched) return step(call("search_catalog", { query: "масло", limit: 10 }));
    const volumes = [...new Set(found.flatMap(volumesOf))].sort(
      (a, b) => Number.parseFloat(a) - Number.parseFloat(b),
    );
    const chosen = volumes.find((volume) => text.replace(",", ".").includes(volume.split(" ")[0]!));
    const contacts = /телефон|контакт|phone/u.test(dialogText);
    const lead = contacts
      ? "Позвоните +7 705 555 01 01 или зайдите на https://shop.example.kz. "
      : "";
    if (askedIntent === "pick_by_params" && chosen) {
      return step(
        call("propose", {
          intent: "pick_by_params",
          text: `${lead}Подходящее масло, ${chosen}.`,
          itemIds: found.filter((item) => volumesOf(item).includes(chosen)).map((item) => item.id),
        }),
      );
    }
    if (volumes.length > 1) {
      return step(
        call("ask_user", {
          intent: "pick_by_params",
          question: "Какой объём канистры нужен?",
          options: volumes,
        }),
      );
    }
    return step(
      call("propose", {
        intent: "pick_by_params",
        text: `${lead}Вот подходящее масло.`,
        itemIds: found.map((item) => item.id),
      }),
    );
  }

  if (!searched) {
    const query = said.trim().slice(0, 100);
    return step(call("search_catalog", { query: query.length >= 2 ? query : "масло", limit: 5 }));
  }
  return step(
    call("propose", {
      intent: "pick_by_params",
      text: "Вот что нашлось.",
      itemIds: found.slice(0, 3).map((item) => item.id),
    }),
  );
}
