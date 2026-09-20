import { describe, expect, it } from "vitest";
import { AI_MODELS, AiGatewayError, translateOutputSchema } from "./ai-gateway";
import { estimateCostUsd } from "./ai-pricing";
import { ClaudeAiGateway, classify } from "./claude-ai-gateway";
import { TestAiGateway, testTranslation } from "./test-ai-gateway";

const SIGNAL = new AbortController().signal;
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
    const first = await gateway.translate(REQUEST, SIGNAL);
    const second = await gateway.translate(REQUEST, SIGNAL);
    expect(first.output).toEqual(second.output);
    expect(translateOutputSchema.parse(first.output).translations).toEqual([
      { id: "0", lang: "kk", text: "Тормозные колодки [kk]" },
      { id: "0", lang: "en", text: "Tormoznye kolodki [en]" },
      { id: "1", lang: "en", text: "Os [en]" },
    ]);
    expect(first.model).toBe(AI_MODELS.standard);
    expect(first.usage.tokensIn).toBeGreaterThan(0);
    expect(first.usage.tokensOut).toBeGreaterThan(0);
    expect(first.usage.costUsd).toBe(estimateCostUsd(AI_MODELS.standard, first.usage));
    expect(gateway.requests).toHaveLength(2);
    // Cut so the result fits.
    expect(testTranslation("x".repeat(60), "kk", 40)).toHaveLength(40);
    expect(testTranslation("Ось", "en", 40)).toBe("Os [en]");
  });

  it("fails like an unavailable provider and like a refusing one", async () => {
    const gateway = new TestAiGateway();
    gateway.mode = "unavailable";
    await expect(gateway.translate(REQUEST, SIGNAL)).rejects.toMatchObject({ kind: "unavailable" });
    gateway.mode = "rejected";
    await expect(gateway.translate(REQUEST, SIGNAL)).rejects.toMatchObject({ kind: "rejected" });
    expect(gateway.requests).toHaveLength(2);
  });

  it("answers slowly, and stops when the call is cut", async () => {
    const gateway = new TestAiGateway();
    gateway.mode = "slow";
    gateway.delayMs = 40;
    const startedAt = Date.now();
    await gateway.translate(REQUEST, SIGNAL);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);

    gateway.delayMs = 10_000;
    const controller = new AbortController();
    const pending = gateway.translate(REQUEST, controller.signal);
    controller.abort(new AiGatewayError("unavailable", "cut"));
    await expect(pending).rejects.toMatchObject({ kind: "unavailable", message: "cut" });
  });

  it("answers with texts the checks refuse, and can decide one text", async () => {
    const gateway = new TestAiGateway();
    for (const mode of ["empty", "too_long", "control_characters", "wrong_language"] as const) {
      gateway.mode = mode;
      const { output } = await gateway.translate(REQUEST, SIGNAL);
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
    const { output } = await gateway.translate(REQUEST, SIGNAL);
    expect(translateOutputSchema.parse(output).translations.at(-1)).toEqual({
      id: "1",
      lang: "en",
      text: "Axle",
    });
  });
});

describe("AI prices", () => {
  it("counts the cost of the models of ARCHITECTURE 9.6 and admits not knowing others", () => {
    expect(estimateCostUsd("claude-sonnet-5", { tokensIn: 1_000_000, tokensOut: 1_000_000 })).toBe(
      12,
    );
    expect(estimateCostUsd("claude-opus-5", { tokensIn: 1000, tokensOut: 100 })).toBe(0.0075);
    expect(estimateCostUsd("claude-haiku-4-5", { tokensIn: 0, tokensOut: 0 })).toBe(0);
    expect(estimateCostUsd("some-future-model", { tokensIn: 1, tokensOut: 1 })).toBeNull();
  });
});

/** An answer of the Messages API, as the SDK reads it. */
function message(body: object, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "x-should-retry": "false", ...init.headers },
  });
}

const ANSWER = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        translations: [
          { id: "0", lang: "kk", text: "Тежегіш қалыптары" },
          { id: "0", lang: "en", text: "Brake pads" },
        ],
      }),
    },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 40 },
};

describe("the Claude provider (no call to the real service: an HTTP stand-in)", () => {
  function gatewayWith(respond: (request: Request) => Response | Promise<Response>) {
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const gateway = new ClaudeAiGateway("sk-ant-test-key-not-real", {
      baseURL: "http://claude.test",
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

  it("asks claude-sonnet-5 for structured output and returns the answer with the usage and cost", async () => {
    const { gateway, seen } = gatewayWith(() => message(ANSWER));
    const result = await gateway.translate({ items: [REQUEST.items[0]!] }, SIGNAL);
    expect(result.model).toBe("claude-sonnet-5");
    expect(translateOutputSchema.parse(result.output).translations).toHaveLength(2);
    expect(result.usage).toEqual({
      tokensIn: 120,
      tokensOut: 40,
      costUsd: estimateCostUsd("claude-sonnet-5", { tokensIn: 120, tokensOut: 40 }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://claude.test/v1/messages");
    expect(seen[0]!.headers.get("x-api-key")).toBe("sk-ant-test-key-not-real");
    expect(seen[0]!.body).toMatchObject({
      model: "claude-sonnet-5",
      output_config: { format: { type: "json_schema" } },
    });
    // The catalog texts went as data of the request, nothing else of ours.
    expect(JSON.stringify(seen[0]!.body)).toContain("Тормозные колодки");
  });

  it("maps failures: a busy or broken provider may recover, a refusing one won't", async () => {
    const status = async (code: number) => {
      const { gateway } = gatewayWith(() =>
        message({ type: "error", error: { type: "api_error", message: "x" } }, { status: code }),
      );
      return gateway.translate(REQUEST, SIGNAL).catch((error: unknown) => error);
    };
    for (const code of [429, 500, 529, 408]) {
      expect(await status(code), String(code)).toMatchObject({ kind: "unavailable" });
    }
    for (const code of [400, 401, 403, 404]) {
      expect(await status(code), String(code)).toMatchObject({ kind: "rejected" });
    }
    const unreachable = new ClaudeAiGateway("sk-ant-test-key-not-real", {
      baseURL: "http://claude.test",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(unreachable.translate(REQUEST, SIGNAL)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("refuses answers that are not usable: a refusal, a cut-off text, no structure", async () => {
    const answer = async (patch: object) => {
      const { gateway } = gatewayWith(() => message({ ...ANSWER, ...patch }));
      return gateway.translate(REQUEST, SIGNAL).catch((error: unknown) => error);
    };
    expect(await answer({ stop_reason: "refusal" })).toMatchObject({ kind: "rejected" });
    expect(await answer({ stop_reason: "max_tokens" })).toMatchObject({ kind: "invalid_output" });
    expect(await answer({ content: [{ type: "text", text: "not json at all" }] })).toMatchObject({
      kind: expect.stringMatching(/invalid_output|unavailable/) as string,
    });
  });

  it("classifies what it can't recognize as temporary", () => {
    expect(classify(new Error("boom"))).toMatchObject({ kind: "unavailable" });
    const own = new AiGatewayError("rejected", "x");
    expect(classify(own)).toBe(own);
  });
});
