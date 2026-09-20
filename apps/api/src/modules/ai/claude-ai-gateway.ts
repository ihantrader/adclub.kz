import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  AI_MODELS,
  AiGateway,
  AiGatewayError,
  translateOutputSchema,
  type AiResult,
  type TranslateInput,
} from "./ai-gateway";
import { estimateCostUsd } from "./ai-pricing";

const TRANSLATE_SYSTEM = `You translate short names of an automotive parts and services catalog (spare parts, fluids, categories, product attributes and their options, units of measure) from Russian into the languages listed for each item: Kazakh (kk) and/or English (en).

Rules:
- Translate the meaning the way a catalog of a car parts shop would name it; keep brand names, article numbers, viscosity grades (5W-30), standards and model codes as they are.
- Kazakh is written in Cyrillic (the current official Kazakh Cyrillic alphabet), English in Latin letters.
- A translation is a name, not a sentence: no quotes, no explanations, no trailing punctuation unless the source has it.
- Never exceed the maxLength of an item (characters); if the natural translation is longer, use the shorter common term.
- Return exactly one translation for every item and each of the languages listed for it, using the item's id.`;

/**
 * Anthropic behind `AiGateway` (ARCHITECTURE 9.6): `claude-sonnet-5`, the
 * answer constrained to the schema of the operation (structured output),
 * failures classified for `AiService` (retryable or not). Built only when a
 * key is configured (`ANTHROPIC_API_KEY`); nothing in development, tests or
 * CI calls it — tests give it a stand-in HTTP layer (`fetch`), TASK-012
 * has no key to try it with.
 */
export class ClaudeAiGateway extends AiGateway {
  readonly provider = "claude" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, options: { fetch?: typeof fetch; baseURL?: string } = {}) {
    super();
    this.client = new Anthropic({
      apiKey,
      // The retries of the queue and of `AiService`'s own time limit decide
      // how long a translation is tried; one quick retry of the SDK is enough.
      maxRetries: 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async translate(input: TranslateInput, signal: AbortSignal): Promise<AiResult> {
    const request = {
      items: input.items.map((item) => ({
        id: item.id,
        text: item.text,
        context: item.context,
        maxLength: item.maxLength,
        languages: item.languages,
      })),
    };
    let response;
    try {
      response = await this.client.messages.parse(
        {
          model: AI_MODELS.standard,
          max_tokens: 16_000,
          system: TRANSLATE_SYSTEM,
          messages: [
            {
              role: "user",
              content: `Translate these items:\n${JSON.stringify(request)}`,
            },
          ],
          // A short-answer task: little thinking is needed.
          output_config: { effort: "low", format: zodOutputFormat(translateOutputSchema) },
        },
        { signal },
      );
    } catch (error) {
      throw classify(error);
    }
    if (response.stop_reason === "refusal") {
      throw new AiGatewayError("rejected", "The model refused the request");
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiGatewayError("invalid_output", "The answer was cut off (max_tokens)");
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new AiGatewayError("invalid_output", "The answer has no structured output");
    }
    const usage = {
      tokensIn:
        response.usage.input_tokens +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0),
      tokensOut: response.usage.output_tokens,
    };
    return {
      output: response.parsed_output,
      model: response.model,
      usage: { ...usage, costUsd: estimateCostUsd(response.model, usage) },
    };
  }
}

/**
 * What a failure of the SDK means for the work: a connection problem, a
 * timeout, a rate limit and a server error may pass (`unavailable`); a
 * refused request (any other 4xx: 400, 401, 402, 403, 404, 413, 422) never will
 * (`rejected`). The message names the kind of error and the status, never
 * the request or the answer.
 */
export function classify(error: unknown): unknown {
  if (error instanceof AiGatewayError) {
    return error;
  }
  if (error instanceof Anthropic.APIUserAbortError) {
    // The caller's own abort (`AiService`'s time limit): it knows why.
    return error;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiGatewayError("unavailable", "The AI provider could not be reached", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 408 || status === 409 || status === 429 || (status ?? 0) >= 500) {
      return new AiGatewayError("unavailable", `The AI provider answered ${String(status)}`, {
        cause: error,
      });
    }
    if (status !== undefined && status >= 400) {
      return new AiGatewayError(
        "rejected",
        `The AI provider refused the request (${String(status)})`,
        {
          cause: error,
        },
      );
    }
  }
  return new AiGatewayError("unavailable", "The AI call failed unexpectedly", { cause: error });
}
