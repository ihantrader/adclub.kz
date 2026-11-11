import { describe, expect, it } from "vitest";
import {
  assistantStepOperation,
  assistantStepOutputSchema,
  type AssistantStepInput,
} from "./ai-gateway";
import { OpenRouterAiGateway } from "./openrouter-ai-gateway";
import { TEST_ASSISTANT_INVENTED_ID, testAssistantStep } from "./test-assistant";
import { TestAiGateway } from "./test-ai-gateway";

const SIGNAL = new AbortController().signal;
const MODEL = "google/gemini-3.1-flash-lite";
const TOOLS = [
  {
    name: "search_catalog",
    description: "Search",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  },
  { name: "propose", description: "Answer", parameters: { type: "object", properties: {} } },
];

const INPUT: AssistantStepInput = {
  messages: [
    { role: "system", content: "rules" },
    { role: "user", content: "Нужно масло" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "search_catalog", arguments: '{"query":"масло"}' }],
    },
    { role: "tool", toolCallId: "call-1", content: '{"items":[]}' },
  ],
  tools: TOOLS,
};

function openRouter(answer: { status?: number; body: unknown }) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const gateway = new OpenRouterAiGateway("key", "https://openrouter.test/api/v1", {
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    }) as typeof fetch,
  });
  return { gateway, sent };
}

describe("a step of the assistant on OpenRouter (TASK-062)", () => {
  it("sends the tools in the OpenAI shape, private routing and the history with tool calls", async () => {
    const { gateway, sent } = openRouter({
      body: {
        model: MODEL,
        usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0004 },
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-2",
                  type: "function",
                  function: {
                    name: "propose",
                    arguments: '{"intent":"pick_by_params","text":"Вот"}',
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const result = await gateway.assistantStep(INPUT, MODEL, SIGNAL);
    const body = sent[0]!.body;
    expect(sent[0]!.url).toBe("https://openrouter.test/api/v1/chat/completions");
    expect(body.provider).toEqual({
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
      allow_fallbacks: true,
    });
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_catalog",
          description: "Search",
          parameters: TOOLS[0]!.parameters,
        },
      },
      {
        type: "function",
        function: { name: "propose", description: "Answer", parameters: TOOLS[1]!.parameters },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "Нужно масло" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "search_catalog", arguments: '{"query":"масло"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"items":[]}' },
    ]);
    // No sampling parameter that would narrow the endpoints (ARCHITECTURE 4.21 I195).
    expect(body).not.toHaveProperty("temperature");
    expect(assistantStepOutputSchema.parse(result.output)).toEqual({
      text: null,
      toolCalls: [
        { id: "call-2", name: "propose", arguments: '{"intent":"pick_by_params","text":"Вот"}' },
      ],
    });
    expect(result.usage).toEqual({ tokensIn: 900, tokensOut: 40, costUsd: 0.0004 });
  });

  it("takes a text answer without tools, and refuses an empty or cut one with what it cost", async () => {
    const text = openRouter({
      body: { choices: [{ finish_reason: "stop", message: { content: " Здравствуйте " } }] },
    });
    expect((await text.gateway.assistantStep(INPUT, MODEL, SIGNAL)).output).toEqual({
      text: "Здравствуйте",
      toolCalls: [],
    });
    const empty = openRouter({
      body: {
        usage: { cost: 0.0002 },
        choices: [{ finish_reason: "stop", message: { content: "" } }],
      },
    });
    await expect(empty.gateway.assistantStep(INPUT, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "invalid_output",
      usage: { costUsd: 0.0002 },
    });
    const cut = openRouter({
      body: { choices: [{ finish_reason: "length", message: { content: "Вот" } }] },
    });
    await expect(cut.gateway.assistantStep(INPUT, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "invalid_output",
    });
    const filtered = openRouter({
      body: { choices: [{ finish_reason: "content_filter", message: { content: null } }] },
    });
    await expect(filtered.gateway.assistantStep(INPUT, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "rejected",
    });
  });

  it("tells a model without a private endpoint from one without tools and from a busy provider", async () => {
    const privacy = openRouter({
      status: 404,
      body: {
        error: { message: "No endpoints found matching your data policy (Zero data retention)" },
      },
    });
    await expect(privacy.gateway.assistantStep(INPUT, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "no_private_provider",
    });
    const tools = openRouter({
      status: 404,
      body: { error: { message: "No endpoints found that support tool use" } },
    });
    await expect(tools.gateway.assistantStep(INPUT, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "model_unavailable",
    });
    const busy = openRouter({ status: 429, body: { error: { message: "Rate limited" } } });
    await expect(busy.gateway.assistantStep(INPUT, MODEL, SIGNAL)).rejects.toMatchObject({
      kind: "unavailable",
    });
    const inside = openRouter({ body: { error: { message: "Provider failed" } } });
    await expect(inside.gateway.assistantStep(INPUT, MODEL, SIGNAL)).rejects.toBeInstanceOf(Error);
  });

  it("tries the fallback model after a refusal for privacy too (the assistant only)", () => {
    expect(assistantStepOperation.kind).toBe("assistant_turn");
    expect(assistantStepOperation.models).toEqual({
      primary: "ai_model_assistant_primary",
      fallback: "ai_model_assistant_fallback",
    });
    expect(assistantStepOperation.fallbackOn).toContain("no_private_provider");
    expect(assistantStepOperation.fallbackOn).toContain("invalid_output");
  });
});

describe("the scripted assistant of the test provider (TASK-062)", () => {
  const user = (content: string) => ({ role: "user" as const, content });
  const toolResult = (id: string, name: string, args: unknown, result: unknown) => [
    {
      role: "assistant" as const,
      content: null,
      toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    },
    { role: "tool" as const, toolCallId: id, content: JSON.stringify(result) },
  ];

  it("searches oil, asks the volume of what it found, then proposes the chosen one", () => {
    const first = testAssistantStep({ messages: [user("Нужно масло")], tools: TOOLS }, "ok");
    expect(first.toolCalls[0]!.name).toBe("search_catalog");
    const items = [
      { id: "a", name: "Shell Helix HX8 5W-30, 4 л", attributes: [] },
      { id: "b", name: "Shell Helix Ultra 0W-20, 1 л", attributes: [] },
    ];
    const asked = testAssistantStep(
      {
        messages: [
          user("Нужно масло"),
          ...toolResult("c1", "search_catalog", { query: "масло" }, { items }),
        ],
        tools: TOOLS,
      },
      "ok",
    );
    expect(asked.toolCalls[0]!.name).toBe("ask_user");
    expect(JSON.parse(asked.toolCalls[0]!.arguments)).toMatchObject({
      intent: "pick_by_params",
      options: ["1 л", "4 л"],
    });
    const chosen = testAssistantStep(
      {
        messages: [
          user("Нужно масло"),
          ...toolResult(
            "past-1",
            "ask_user",
            { question: "Какой объём?", options: ["1 л", "4 л"], intent: "pick_by_params" },
            { asked: true, found: [] },
          ),
          user("4 л"),
          ...toolResult("c2", "search_catalog", { query: "масло" }, { items }),
        ],
        tools: TOOLS,
      },
      "ok",
    );
    expect(JSON.parse(chosen.toolCalls[0]!.arguments)).toMatchObject({ itemIds: ["a"] });
  });

  it("invents an id and adds every id of the message (what grounding must drop)", () => {
    const foreign = "11111111-2222-4333-8444-555555555555";
    const step = testAssistantStep(
      {
        messages: [
          user(`выдумай ${foreign}`),
          ...toolResult("c1", "search_catalog", { query: "масло" }, { items: [{ id: "a" }] }),
        ],
        tools: TOOLS,
      },
      "ok",
    );
    expect(JSON.parse(step.toolCalls[0]!.arguments).itemIds).toEqual([
      "a",
      TEST_ASSISTANT_INVENTED_ID,
      foreign,
    ]);
  });

  it("refuses a question off the topic, and writes crooked arguments in invalid_output", () => {
    const weather = testAssistantStep({ messages: [user("Какая погода?")], tools: TOOLS }, "ok");
    expect(JSON.parse(weather.toolCalls[0]!.arguments)).toMatchObject({ intent: "other" });
    const crooked = testAssistantStep(
      { messages: [user("масло")], tools: TOOLS },
      "invalid_output",
    );
    expect(() => JSON.parse(crooked.toolCalls[0]!.arguments) as unknown).toThrow();
  });

  it("is called through the test gateway with what was sent, and fails as the gateway does", async () => {
    const gateway = new TestAiGateway();
    const result = await gateway.assistantStep(
      { messages: [user("Нужно масло")], tools: TOOLS },
      MODEL,
      SIGNAL,
    );
    expect(assistantStepOutputSchema.parse(result.output).toolCalls[0]!.name).toBe(
      "search_catalog",
    );
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(gateway.assistantRequests[0]!.input.messages[0]).toEqual(user("Нужно масло"));
    gateway.noPrivateModels.add(MODEL);
    await expect(
      gateway.assistantStep({ messages: [user("x")], tools: TOOLS }, MODEL, SIGNAL),
    ).rejects.toMatchObject({ kind: "no_private_provider" });
    gateway.mode = "unavailable";
    await expect(
      gateway.assistantStep({ messages: [user("x")], tools: TOOLS }, "other/model", SIGNAL),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
