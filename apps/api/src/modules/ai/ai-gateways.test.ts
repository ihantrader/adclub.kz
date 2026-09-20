import { describe, expect, it } from "vitest";
import { AiGatewayError, translateOutputSchema } from "./ai-gateway";
import { OpenRouterAiGateway, failureOf, strictJsonSchema } from "./openrouter-ai-gateway";
import { MISSING_MODEL_PREFIX, TestAiGateway, testTranslation } from "./test-ai-gateway";

const SIGNAL = new AbortController().signal;
const MODEL = "google/gemini-3.8-flash";
const REQUEST = {
  items: [
    {
      id: "0",
      text: "Тормозные колодки",
      context: "a name",
      maxLength: 40,
      languages: ["kk", "en"] as const,
    },
    { id: "1", text: "Ось", context: "a name", maxLength: 40, languages: ["en"] as const },
  ],
};

describe("the test AI provider", () => {
  it("translates deterministically, plainly not a real translation, within the limit", async () => {
    const gateway = new TestAiGateway();
    const first = await gateway.translate(REQUEST, MODEL, SIGNAL);
    const second = await gateway.translate(REQUEST, MODEL, SIGNAL);
    expect(first.output).toEqual(second.output);
    expect(translateOutputSchema.parse(first.output).translations).toEqual([
      { id: "0", lang: "kk", text: "Тормозные колодки [kk]" },
      { id: "0", lang: "en", text: "Tormoznye kolodki [en]" },
      { id: "1", lang: "en", text: "Os [en]" },
    ]);
    // The model it was asked of, as a provider reports what answered.
    expect(first.model).toBe(MODEL);
    expect(first.usage.tokensIn).toBeGreaterThan(0);
    expect(first.usage.tokensOut).toBeGreaterThan(0);
    expect(first.usage.costUsd).toBeGreaterThan(0);
    expect(gateway.requests.map((request) => request.model)).toEqual([MODEL, MODEL]);
    // Cut so the result fits.
    expect(testTranslation("x".repeat(60), "kk", 40)).toHaveLength(40);
    expect(testTranslation("Ось", "en", 40)).toBe("Os [en]");
  });

  it("refuses a model it does not have, so the fallback can be seen without a key", async () => {
    const gateway = new TestAiGateway();
    await expect(
      gateway.translate(REQUEST, `${MISSING_MODEL_PREFIX}whatever`, SIGNAL),
    ).rejects.toMatchObject({ kind: "model_unavailable" });
    gateway.failingModels.add(MODEL);
    await expect(gateway.translate(REQUEST, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "model_unavailable",
    });
  });

  it("fails like an unavailable provider, a refusing one and one that stores requests", async () => {
    const gateway = new TestAiGateway();
    gateway.mode = "unavailable";
    await expect(gateway.translate(REQUEST, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "unavailable",
    });
    gateway.mode = "rejected";
    await expect(gateway.translate(REQUEST, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "rejected",
    });
    gateway.mode = "no_private_provider";
    await expect(gateway.translate(REQUEST, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "no_private_provider",
    });
    expect(gateway.requests).toHaveLength(3);
  });

  it("answers slowly, and stops when the call is cut", async () => {
    const gateway = new TestAiGateway();
    gateway.mode = "slow";
    gateway.delayMs = 40;
    const startedAt = Date.now();
    await gateway.translate(REQUEST, MODEL, SIGNAL);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);

    gateway.delayMs = 10_000;
    const controller = new AbortController();
    const pending = gateway.translate(REQUEST, MODEL, controller.signal);
    controller.abort(new AiGatewayError("unavailable", "cut"));
    await expect(pending).rejects.toMatchObject({ kind: "unavailable", message: "cut" });
  });

  it("answers about part of the batch, and without saying what the call cost", async () => {
    const gateway = new TestAiGateway();
    gateway.mode = "incomplete";
    const partial = await gateway.translate(REQUEST, MODEL, SIGNAL);
    // Three were asked for, two came back.
    expect(translateOutputSchema.parse(partial.output).translations).toHaveLength(2);

    gateway.mode = "no_cost";
    const free = await gateway.translate(REQUEST, MODEL, SIGNAL);
    expect(free.usage.costUsd).toBeNull();
    expect(free.usage.tokensIn).toBeGreaterThan(0);
  });

  it("answers with texts the checks refuse, and can decide one text", async () => {
    const gateway = new TestAiGateway();
    for (const mode of ["empty", "too_long", "control_characters", "wrong_language"] as const) {
      gateway.mode = mode;
      const { output } = await gateway.translate(REQUEST, MODEL, SIGNAL);
      const texts = translateOutputSchema.parse(output).translations.map((entry) => entry.text);
      expect(texts, mode).toHaveLength(3);
      if (mode === "empty") {
        expect(texts.every((text) => text === "")).toBe(true);
      }
      if (mode === "too_long") {
        expect(texts.every((text) => text.length === 41)).toBe(true);
      }
    }
    gateway.mode = "ok";
    gateway.override = (item, lang) => (item.id === "1" && lang === "en" ? "Axle" : undefined);
    const { output } = await gateway.translate(REQUEST, MODEL, SIGNAL);
    expect(translateOutputSchema.parse(output).translations.at(-1)).toEqual({
      id: "1",
      lang: "en",
      text: "Axle",
    });
  });
});

describe("the JSON Schema sent to OpenRouter", () => {
  it("closes every object, so a strict structured answer has nothing extra in it", () => {
    const schema = strictJsonSchema(translateOutputSchema);
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    const items = (schema.properties as Record<string, Record<string, unknown>>).translations
      .items as Record<string, unknown>;
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(["id", "lang", "text"]);
  });
});

const KEY = "sk-or-v1-test-key-not-real";

function answer(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ANSWER = {
  id: "gen-test",
  model: "google/gemini-3.8-flash",
  choices: [
    {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify({
          translations: [
            { id: "0", lang: "kk", text: "Тежегіш қалыптары" },
            { id: "0", lang: "en", text: "Brake pads" },
          ],
        }),
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 40, cost: 0.000345 },
};

describe("the OpenRouter provider (no call to the real service: an HTTP stand-in)", () => {
  function gatewayWith(respond: (request: Request) => Response | Promise<Response>) {
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const gateway = new OpenRouterAiGateway(KEY, "http://openrouter.test/api/v1", {
      fetch: async (input, init) => {
        const request = new Request(input as string | URL | Request, init);
        seen.push({
          url: request.url,
          headers: request.headers,
          body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
        });
        return respond(request);
      },
    });
    return { gateway, seen };
  }

  it("asks the model it was given, for structured output, only from providers that keep nothing", async () => {
    const { gateway, seen } = gatewayWith(() => answer(ANSWER));
    const result = await gateway.translate({ items: [REQUEST.items[0]!] }, MODEL, SIGNAL);
    expect(result.model).toBe(MODEL);
    expect(translateOutputSchema.parse(result.output).translations).toHaveLength(2);
    // The cost is the provider's own figure, not a price list of ours.
    expect(result.usage).toEqual({ tokensIn: 120, tokensOut: 40, costUsd: 0.000345 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://openrouter.test/api/v1/chat/completions");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toMatchObject({
      model: MODEL,
      response_format: { type: "json_schema", json_schema: { strict: true } },
      // D-057, in every request.
      provider: { zdr: true, data_collection: "deny", require_parameters: true },
    });
    // The catalog texts went as data of the request, nothing else of ours.
    expect(JSON.stringify(seen[0]!.body)).toContain("Тормозные колодки");
    expect(JSON.stringify(seen[0]!.body)).not.toContain(KEY);
  });

  it("does not read a missing or zero cost as free", async () => {
    const without = gatewayWith(() => answer({ ...ANSWER, usage: undefined }));
    expect((await without.gateway.translate(REQUEST, MODEL, SIGNAL)).usage.costUsd).toBeNull();
    const zero = gatewayWith(() =>
      answer({ ...ANSWER, usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }),
    );
    expect((await zero.gateway.translate(REQUEST, MODEL, SIGNAL)).usage.costUsd).toBeNull();
  });

  it("tells a model with no private provider apart from a model it does not have", async () => {
    const refuse = async (message: string) => {
      const { gateway } = gatewayWith(() => answer({ error: { message, code: 404 } }, 404));
      return gateway.translate(REQUEST, MODEL, SIGNAL).catch((error: unknown) => error);
    };
    expect(
      await refuse("No endpoints found matching your data policy (Zero data retention)"),
    ).toMatchObject({ kind: "no_private_provider" });
    expect(await refuse("No endpoints found for nonexistent/model")).toMatchObject({
      kind: "model_unavailable",
    });
  });

  it("maps failures: a busy or broken provider may recover, a refusing one won't", async () => {
    const status = async (code: number) => {
      const { gateway } = gatewayWith(() => answer({ error: { message: "x", code } }, code));
      return gateway.translate(REQUEST, MODEL, SIGNAL).catch((error: unknown) => error);
    };
    for (const code of [429, 500, 502, 408]) {
      expect(await status(code), String(code)).toMatchObject({ kind: "unavailable" });
    }
    for (const code of [400, 401, 402, 403]) {
      expect(await status(code), String(code)).toMatchObject({ kind: "rejected" });
    }
    const unreachable = new OpenRouterAiGateway(KEY, "http://openrouter.test/api/v1", {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(unreachable.translate(REQUEST, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("refuses answers that are not usable: an error in a 200, a cut-off text, no structure", async () => {
    const given = async (body: object) => {
      const { gateway } = gatewayWith(() => answer(body));
      return gateway.translate(REQUEST, MODEL, SIGNAL).catch((error: unknown) => error);
    };
    expect(await given({ ...ANSWER, error: { message: "upstream died" } })).toMatchObject({
      kind: "unavailable",
    });
    expect(
      await given({ ...ANSWER, choices: [{ ...ANSWER.choices[0], finish_reason: "length" }] }),
    ).toMatchObject({ kind: "invalid_output" });
    expect(
      await given({
        ...ANSWER,
        choices: [{ ...ANSWER.choices[0], finish_reason: "content_filter" }],
      }),
    ).toMatchObject({ kind: "rejected" });
    expect(
      await given({
        ...ANSWER,
        choices: [{ finish_reason: "stop", message: { content: "not json at all" } }],
      }),
    ).toMatchObject({ kind: "invalid_output" });
    expect(await given({ ...ANSWER, choices: [] })).toMatchObject({ kind: "invalid_output" });
  });

  it("names the kind of trouble and the status, never our request", () => {
    expect(failureOf(503, "upstream unavailable")).toMatchObject({ kind: "unavailable" });
    expect(failureOf(404, undefined)).toMatchObject({ kind: "model_unavailable" });
    expect(failureOf(401, "invalid api key").message).not.toContain(KEY);
  });
});
