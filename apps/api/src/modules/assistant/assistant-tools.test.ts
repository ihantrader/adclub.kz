import { describe, expect, it } from "vitest";
import { ASSISTANT_RULES, dialogContext } from "./assistant-prompt";
import { ASSISTANT_TOOLS, proposeArgs, searchCatalogArgs } from "./assistant-tools";
import { loadAssistantScenarios } from "./eval/assistant-eval";

describe("the tools of the assistant (TASK-062)", () => {
  it("are the six of ARCHITECTURE 4.85, in a fixed order (the start of every request is the same)", () => {
    expect(ASSISTANT_TOOLS.map((tool) => tool.name)).toEqual([
      "search_catalog",
      "get_item",
      "get_maintenance_plan",
      "list_categories",
      "ask_user",
      "propose",
    ]);
  });

  it("describe their arguments in the subset every provider takes (no pattern, format or additionalProperties)", () => {
    const text = JSON.stringify(ASSISTANT_TOOLS);
    expect(text).not.toMatch(/"pattern"|"format"|"additionalProperties"|"\$schema"/u);
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.parameters.type, tool.name).toBe("object");
    }
  });

  it("check the arguments on the server with the full schema", () => {
    expect(searchCatalogArgs.safeParse({}).success).toBe(false);
    expect(searchCatalogArgs.safeParse({ categoryId: "not-a-uuid" }).success).toBe(false);
    expect(searchCatalogArgs.safeParse({ query: "масло", limit: 11 }).success).toBe(false);
    expect(searchCatalogArgs.safeParse({ query: "масло", limit: 5 }).success).toBe(true);
    expect(proposeArgs.safeParse({ text: "x", intent: "diagnosis" }).success).toBe(false);
  });

  it("tell the model the car, the city, the mileage and the language — nothing about the person", () => {
    const context = dialogContext({
      car: {
        make: "Geely",
        model: "Coolray",
        generation: "I (SX11)",
        year: 2024,
        engine: "JLH-3G15TD 1.5 л",
      },
      city: "Алматы",
      mileageKm: 31_000,
      lang: "kk",
    });
    expect(context).toContain("Geely, Coolray, generation I (SX11), 2024, engine JLH-3G15TD 1.5 л");
    expect(context).toContain("31000 km");
    expect(context).toContain("Answer in Kazakh");
    expect(ASSISTANT_RULES).toMatch(/never diagnose/u);
    expect(ASSISTANT_RULES).toMatch(/Never name suppliers/u);
  });
});

describe("the scenarios of the model comparison (ai-eval/assistant)", () => {
  it("cover the three kinds of PRODUCT 8.3, the refusals and the languages, 30 and more", () => {
    const file = loadAssistantScenarios();
    expect(file.scenarios.length).toBeGreaterThanOrEqual(30);
    expect(new Set(file.scenarios.map((scenario) => scenario.id)).size).toBe(file.scenarios.length);
    const intents = new Set(file.scenarios.map((scenario) => scenario.expect.intent));
    expect(intents).toEqual(new Set(["pick_by_params", "maintenance", "symptom", "other"]));
    expect(new Set(file.scenarios.map((scenario) => scenario.lang))).toEqual(
      new Set(["ru", "kk", "en"]),
    );
    for (const scenario of file.scenarios) {
      expect(file.cars[scenario.car], scenario.id).toBeDefined();
    }
  });
});
