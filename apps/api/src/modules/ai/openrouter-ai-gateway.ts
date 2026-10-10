import { z } from "zod";
import {
  AiGateway,
  AiGatewayError,
  translateOutputSchema,
  vehicleDocumentOutputSchema,
  type AiFailureKind,
  type AiResult,
  type AiUsage,
  type TranslateGlossaryEntry,
  type TranslateInput,
  type VehicleDocumentInput,
} from "./ai-gateway";

/**
 * OpenRouter behind `AiGateway` (D-055, ARCHITECTURE 9.6, 4.20): the only
 * provider of the project — one key, one account, and the model of every
 * operation chosen by a setting (D-056). The API is the OpenAI-shaped
 * `POST /chat/completions`, so plain `fetch` is enough and the project
 * carries no provider SDK.
 *
 * Every request carries the routing requirement of D-057
 * (`provider.zdr`, `provider.data_collection: "deny"`): it may only be
 * served by a provider that does not store the request and does not train
 * on it. If OpenRouter has no such provider for the model, it answers 404
 * and nothing was sent anywhere — that is `no_private_provider`, a
 * failure a person has to decide about, not a retry.
 */

const TRANSLATE_SYSTEM = `You translate short names of an automotive parts and services catalog (spare parts, fluids, categories, product attributes and their options, units of measure) from Russian into the languages listed for each item: Kazakh (kk) and/or English (en).

Rules:
- Translate the meaning the way a catalog of a car parts shop would name it; keep brand names, article numbers, viscosity grades (5W-30), standards and model codes as they are.
- Kazakh is written in Cyrillic (the current official Kazakh Cyrillic alphabet), English in Latin letters.
- A translation is a name, not a sentence: no quotes, no explanations, no trailing punctuation unless the source has it.
- Never exceed the maxLength of an item (characters); if the natural translation is longer, use the shorter common term.
- Return exactly one translation for every item and each of the languages listed for it, using the item's id.`;

/**
 * The line that carries the glossary (TASK-053.B requirement 5). It goes
 * with the texts rather than into the system text above, so the fixed
 * part of the prompt stays the same whether a glossary is sent or not.
 */
const GLOSSARY_INSTRUCTION =
  // The terms are written in lower case, and a model that copies that case
  // gives back names that start with a small letter — measured at 20 of 104
  // names on one of the models tried (TASK-053.B), which a catalog shows as
  // it is. The case of a name is the name's, not the glossary's.
  "Use exactly these terms wherever they occur, adapting the grammatical form to the phrase; the terms are listed in lower case, but each translation keeps the capitalisation of its own text:";

/** The longest answer a translation batch may produce. */
const TRANSLATE_MAX_TOKENS = 16_000;

/**
 * What OpenRouter must be told about routing on every request (D-057):
 * only endpoints that keep nothing (`zdr`) and providers that may not
 * collect data (`data_collection`), and only endpoints that honour every
 * parameter we send — `require_parameters` keeps the request away from an
 * endpoint that would quietly ignore `response_format` and answer prose.
 *
 * `require_parameters` is also why a request carries no parameter it can
 * do without (ARCHITECTURE 4.21 I195): every one of them narrows the
 * endpoints left, and an endpoint that does not take it is dropped rather
 * than asked. `temperature` cost us both default models that way — the
 * endpoints of a reasoning model do not take it, and with it in the body
 * OpenRouter answered 404 "no endpoints found that can handle the
 * requested parameters" and nothing was sent.
 */
const PRIVATE_ROUTING = {
  zdr: true,
  data_collection: "deny",
  require_parameters: true,
  allow_fallbacks: true,
} as const;

/**
 * Markers of the 404 OpenRouter answers when the routing requirement
 * above leaves no endpoint at all, as opposed to the 404 of a model it
 * does not know. Both mean "not sent", but only the first one is about
 * privacy, and an operator has to see which it was.
 */
const NO_PRIVATE_PROVIDER_MARKERS = ["data polic", "data retention", "zdr", "zero data"];

/**
 * How OpenRouter says it does not know a model at all: a 400, not the 404
 * of a model it knows but cannot serve (TASK-053.A — a model id that does
 * not exist answers `"<id> is not a valid model ID"`). It has to be told
 * apart from the other 400s, which are about the request and which no
 * other model would fix: a setting naming a withdrawn or mistyped model is
 * exactly what the fallback model is for (D-056).
 */
const UNKNOWN_MODEL_MARKER = "not a valid model";

const usageSchema = z.object({
  prompt_tokens: z.number().nonnegative().optional(),
  completion_tokens: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
});

const answerSchema = z.object({
  model: z.string().optional(),
  usage: usageSchema.optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish() }).optional(),
      }),
    )
    .optional(),
  error: z.object({ message: z.string().optional(), code: z.unknown().optional() }).optional(),
});

/**
 * The JSON Schema of an operation's answer in the form structured output
 * wants: every object closed and every property required. zod already
 * marks what is required; `additionalProperties: false` is what a strict
 * schema adds.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  const close = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) {
        close(child);
      }
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    const object = node as Record<string, unknown>;
    if (object.type === "object" && typeof object.properties === "object") {
      object.additionalProperties = false;
    }
    for (const value of Object.values(object)) {
      close(value);
    }
  };
  close(json);
  return json;
}

const TRANSLATE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "catalog_translations",
    strict: true,
    schema: strictJsonSchema(translateOutputSchema),
  },
} as const;

const VEHICLE_DOCUMENT_SYSTEM = `You read a photo of a vehicle registration certificate of the Republic of Kazakhstan (Russian: «Свидетельство о регистрации транспортного средства», Kazakh: «Көлік құралын тіркеу туралы куәлік») — the card form issued since 2018 or the older paper form. The labels are in Kazakh and Russian.

Decide documentKind first:
- kz_registration — a Kazakhstan vehicle registration certificate (either form) with its vehicle data visible;
- other_document — any other document: a driving licence, an identity card, a passport, insurance, or a vehicle registration certificate of another country (for example the Russian «СТС», whose plates look like А123ВС77);
- not_document — not a document at all;
- unreadable — it may be the certificate, but it cannot be read.

Only when documentKind is kz_registration, copy these fields exactly as written; otherwise every field is null:
- make and model — the field «Марка, модель / Маркасы, моделі», split into the manufacturer (make) and the model;
- year — the year of manufacture («Год выпуска / Шығарылған жылы»);
- vin — the VIN / identification number, 17 characters, copied character by character. A VIN never contains the letters I, O or Q: a round character in it is the digit 0, a vertical stroke is the digit 1. Tell Z from 2 and S from 5 by their shape; if any character can't be told for sure, vin is null;
- plate — the state registration number («Государственный регистрационный номер / Мемлекеттік тіркеу нөмірі»), e.g. 123ABC02;
- engineVolumeCc — the engine capacity in cm³ («Объём двигателя / Қозғалтқыштың көлемі»), as a whole number;
- color — the colour («Цвет / Түсі») as written.

A field that is absent, covered, cut off or not clearly legible is null — never guess a character, and never fill a field from another one. Do not report the owner, the address, the series or number of the certificate or any other field.`;

/** The longest answer reading a certificate may produce (a reasoning model thinks within it). */
const VEHICLE_DOCUMENT_MAX_TOKENS = 4_000;

const VEHICLE_DOCUMENT_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "vehicle_registration_certificate",
    strict: true,
    schema: strictJsonSchema(vehicleDocumentOutputSchema),
  },
} as const;

export interface OpenRouterOptions {
  /** Tests give their own HTTP layer; nothing in development, tests or CI calls the real service. */
  fetch?: typeof fetch;
}

export class OpenRouterAiGateway extends AiGateway {
  readonly provider = "openrouter" as const;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    options: OpenRouterOptions = {},
  ) {
    super();
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async translate(input: TranslateInput, model: string, signal: AbortSignal): Promise<AiResult> {
    const request = {
      items: input.items.map((item) => ({
        id: item.id,
        text: item.text,
        context: item.context,
        maxLength: item.maxLength,
        languages: item.languages,
      })),
    };
    return this.complete(
      {
        model,
        max_tokens: TRANSLATE_MAX_TOKENS,
        // No `temperature`: the shape of the answer is held by the strict
        // schema, and asking for the parameter loses the endpoints that do
        // not take it (see PRIVATE_ROUTING).
        response_format: TRANSLATE_FORMAT,
        messages: [
          { role: "system", content: TRANSLATE_SYSTEM },
          {
            role: "user",
            content: `${glossaryText(input.glossary)}Translate these items:\n${JSON.stringify(request)}`,
          },
        ],
      },
      signal,
    );
  }

  /**
   * The photo goes inline as a data URL, in this one request and nowhere
   * else (TASK-057): OpenRouter routes it only to an endpoint that keeps
   * nothing (D-057, `PRIVATE_ROUTING`), and `require_parameters` keeps it
   * away from an endpoint of the model that does not take images.
   */
  async readVehicleDocument(
    input: VehicleDocumentInput,
    model: string,
    signal: AbortSignal,
  ): Promise<AiResult> {
    const dataUrl = `data:${input.contentType};base64,${Buffer.from(input.image).toString("base64")}`;
    return this.complete(
      {
        model,
        max_tokens: VEHICLE_DOCUMENT_MAX_TOKENS,
        response_format: VEHICLE_DOCUMENT_FORMAT,
        messages: [
          { role: "system", content: VEHICLE_DOCUMENT_SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Read this photo." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      },
      signal,
    );
  }

  /** One call: the request with the routing requirement, the answer parsed, failures classified. */
  private async complete(body: Record<string, unknown>, signal: AbortSignal): Promise<AiResult> {
    const model = String(body.model);
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          // Attribution of the account's own traffic; no request content.
          "http-referer": "https://adclub.kz",
          "x-title": "adclub.kz",
        },
        body: JSON.stringify({ ...body, provider: PRIVATE_ROUTING }),
      });
    } catch (error) {
      if (signal.aborted && signal.reason instanceof AiGatewayError) {
        // The caller's own time limit: it knows why.
        throw signal.reason;
      }
      throw new AiGatewayError("unavailable", "OpenRouter could not be reached", { cause: error });
    }
    const text = await response.text();
    const parsed = safeJson(text);
    if (!response.ok) {
      throw failureOf(response.status, messageOf(parsed));
    }
    const answer = answerSchema.safeParse(parsed);
    if (!answer.success) {
      throw new AiGatewayError("invalid_output", "OpenRouter answered in an unknown shape");
    }
    // An error can also arrive inside a 200 (a provider that failed mid-stream).
    if (answer.data.error) {
      throw failureOf(response.status, answer.data.error.message);
    }
    // From here on the provider answered and charged for it: every refusal
    // below carries what it cost, so the day counts the real figure and not
    // the reservation (TASK-053.A).
    const reported = answer.data.usage;
    const usage: AiUsage = {
      tokensIn: reported?.prompt_tokens ?? 0,
      tokensOut: reported?.completion_tokens ?? 0,
      // What the provider says it cost (D-055). Missing — unknown, never zero;
      // a cost of exactly 0 is only believable for a free model, and reading
      // it as unknown just keeps the reservation, which is the safe side.
      costUsd: reported?.cost === undefined || reported.cost === 0 ? null : reported.cost,
    };
    const unusable = (message: string, kind: AiFailureKind = "invalid_output"): AiGatewayError =>
      new AiGatewayError(kind, message, { usage });
    const choice = answer.data.choices?.[0];
    if (!choice) {
      throw unusable("OpenRouter answered without a choice");
    }
    if (choice.finish_reason === "length") {
      throw unusable("The answer was cut off (max_tokens)");
    }
    if (choice.finish_reason === "content_filter") {
      throw unusable("The model refused the request", "rejected");
    }
    const content = choice.message?.content;
    if (!content) {
      throw unusable("The answer has no content");
    }
    const output = safeJson(content);
    if (output === undefined) {
      // The text itself is never logged; its size and how it ended are what
      // tell a truncated answer from prose, and they name nothing.
      throw unusable(
        `The answer is not the JSON the schema asked for (${content.length} characters, ${content.trimEnd().endsWith("}") ? "ends closed" : "ends open"})`,
      );
    }
    return { output, model: answer.data.model ?? model, usage };
  }
}

/** The glossary as a block before the texts; nothing at all when there is none. */
function glossaryText(glossary: readonly TranslateGlossaryEntry[] | undefined): string {
  if (!glossary || glossary.length === 0) {
    return "";
  }
  const lines = glossary.map((entry) => {
    const languages = [
      ...(entry.kk === undefined ? [] : [`kk: ${entry.kk}`]),
      ...(entry.en === undefined ? [] : [`en: ${entry.en}`]),
    ];
    return `- ${entry.ru} — ${languages.join("; ")}`;
  });
  return `${GLOSSARY_INSTRUCTION}\n${lines.join("\n")}\n\n`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function messageOf(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const error = (parsed as { error?: unknown }).error;
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

/**
 * What an answer of OpenRouter means for the work. The status says most of
 * it: 401/403 is our key or account, 402 is an empty balance, 429 and 5xx
 * pass, 404 is about the model — and a 404 caused by the privacy
 * requirement (D-057) is told apart by what OpenRouter says, because only
 * then was the request refused for keeping data rather than for the model
 * not existing. A 400 is about the request, which no other model would
 * fix — except the one that says the model id itself is unknown (4.21
 * I196). The message of the provider is kept (it names the model or the
 * policy, never our texts) and `AiService` sanitizes it before it is
 * written anywhere.
 */
export function failureOf(status: number, message: string | undefined): AiGatewayError {
  const said = message ? `: ${message}` : "";
  if (status === 404) {
    const lower = (message ?? "").toLowerCase();
    if (NO_PRIVATE_PROVIDER_MARKERS.some((marker) => lower.includes(marker))) {
      return new AiGatewayError(
        "no_private_provider",
        `No provider of this model keeps requests unstored, so nothing was sent${said}`,
      );
    }
    return new AiGatewayError(
      "model_unavailable",
      `OpenRouter has no endpoint for this model${said}`,
    );
  }
  if (status === 400 && (message ?? "").toLowerCase().includes(UNKNOWN_MODEL_MARKER)) {
    return new AiGatewayError("model_unavailable", `OpenRouter has no such model${said}`);
  }
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return new AiGatewayError("unavailable", `OpenRouter answered ${String(status)}${said}`);
  }
  if (status >= 400) {
    return new AiGatewayError(
      "rejected",
      `OpenRouter refused the request (${String(status)})${said}`,
    );
  }
  return new AiGatewayError("unavailable", `OpenRouter answered ${String(status)}${said}`);
}
