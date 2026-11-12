import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Plain Node checks: this file must not import react-native. The assistant
// always works for a car (D-062, TASK-063), like the catalog: the tab goes
// through the catalog's own rule (`catalogEntry`) and shows the one «нет
// автомобиля» screen without one, and nothing in the assistant sends a
// message without the car of the catalog provider.
const src = join(__dirname, "..");
const read = (path: string) => readFileSync(join(src, path), "utf8");

describe("the assistant exists only for a car (D-062)", () => {
  it("the tab is the catalog's rule: no car — `NoCarContent` and nothing else", () => {
    const tab = read("navigation/AssistantStack.tsx");
    const start = tab.indexOf("export function AssistantTab()");
    const gate = tab.slice(start, tab.indexOf("\n}\n", start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(gate).toMatch(/const entry = catalogEntry\(state\);/u);
    expect(gate).toMatch(/entry\.kind === "needs-car"[\s\S]*<NoCarContent onAdd=/u);
    // With a car the dialog is mounted only under the provider of that car.
    expect(gate).toMatch(/<CatalogCarProvider car=\{entry\.car\}>\s*<AssistantStack \/>/u);
  });

  it("is the fifth tab, in the middle, mounted through that gate", () => {
    const tabs = read("navigation/MainTabs.tsx");
    const order = [...tabs.matchAll(/<Tabs\.Screen name="(\w+)" component=\{(\w+)\}/gu)].map(
      (match) => `${match[1]}:${match[2]}`,
    );
    expect(order).toEqual([
      "catalog:CatalogTab",
      "orders:OrdersScreen",
      "assistant:AssistantTab",
      "garage:GarageStack",
      "profile:ProfileStack",
    ]);
  });

  it("every message names the car of the catalog provider; no way to ask without one", () => {
    const screen = read("screens/assistant/AssistantScreen.tsx");
    expect(screen).toMatch(/const \{ car, chooseCar \} = useCatalogCar\(\);/u);
    expect(screen).toMatch(/sendAssistantMessage\(\{[\s\S]*?car: forCar,/u);
    const service = read("services/assistant.ts");
    expect(service).toMatch(/car: GarageCar;/u);
    expect(`${screen}\n${service}`).not.toMatch(/withoutCar|noCar|car: null|car\?: /u);
  });
});
