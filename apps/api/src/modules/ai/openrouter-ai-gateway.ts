import { z } from "zod";
import {
  AiGateway,
  AiGatewayError,
  translateOutputSchema,
  type AiResult,
  type TranslateInput,
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

/** The longest answer a translation batch may produce. */
const TRANSLATE_MAX_TOKENS = 16_000;

/**
 * What OpenRouter must be told about routing on every request (D-057):
 * only endpoints that keep nothing (`zdr`) and providers that may not
 * collect data (`data_collection`), and only endpoints that honour every
 * parameter we send — `require_parameters` keeps the request away from an
 * endpoint that would quietly ignore `response_format` and answer prose.
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
        // A short-answer task with one right shape: no room for invention.
        temperature: 0,
        response_format: TRANSLATE_FORMAT,
        messages: [
          { role: "system", content: TRANSLATE_SYSTEM },
          { role: "user", content: `Translate these items:\n${JSON.stringify(request)}` },
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
    const choice = answer.data.choices?.[0];
    if (!choice) {
      throw new AiGatewayError("invalid_output", "OpenRouter answered without a choice");
    }
    if (choice.finish_reason === "length") {
      throw new AiGatewayError("invalid_output", "The answer was cut off (max_tokens)");
    }
    if (choice.finish_reason === "content_filter") {
      throw new AiGatewayError("rejected", "The model refused the request");
    }
    const content = choice.message?.content;
    if (!content) {
      throw new AiGatewayError("invalid_output", "The answer has no content");
    }
    const output = safeJson(content);
    if (output === undefined) {
      throw new AiGatewayError("invalid_output", "The answer is not the JSON the schema asked for");
    }
    const usage = answer.data.usage;
    return {
      output,
      model: answer.data.model ?? model,
      usage: {
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
        // What the provider says it cost (D-055). Missing — unknown, never zero;
        // a cost of exactly 0 is only believable for a free model, and reading
        // it as unknown just keeps the reservation, which is the safe side.
        costUsd: usage?.cost === undefined || usage.cost === 0 ? null : usage.cost,
      },
    };
  }
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
 * not existing. The message of the provider is kept (it names the model or
 * the policy, never our texts) and `AiService` sanitizes it before it is
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
