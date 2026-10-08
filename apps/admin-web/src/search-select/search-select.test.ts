import type { ApiClient } from "@adclub/api-client";
import type { AdminBrand, AdminVehicleEngine, AdminVehicleMake } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  createText,
  firstActive,
  listed,
  moveActive,
  SEARCH_PAGE,
  searchQuery,
} from "./search-select-core";
import { createChoiceSources, engineChoice, generationChoice } from "./sources";

const NOW = "2026-10-07T10:00:00.000Z";

function make(index: number, name: string, aliases: string[] = []): AdminVehicleMake {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name,
    aliases,
    source: "manual",
    status: "active",
    version: 1,
    archivedAt: null,
    updatedAt: NOW,
    modelCount: 0,
    activeModelCount: 0,
  };
}

/**
 * A server of 150 makes that searches like the real one: a part of any
 * spelling, case and spaces ignored, by name, one page of `limit`.
 */
function fakeServer() {
  const makes = [
    ...Array.from({ length: 149 }, (_, index) =>
      make(index, `Марка ${String(index).padStart(3, "0")}`),
    ),
    make(149, "Geely", ["Джили", "GEELY Auto"]),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const key = (text: string) => text.toLowerCase().replace(/\s+/g, "");
  const asked: { q?: string; limit?: number }[] = [];
  const client = {
    listVehicleMakes: async ({ query }: { query: { q?: string; limit?: number } }) => {
      asked.push(query);
      const found = makes.filter(
        (entry) =>
          !query.q ||
          [entry.name, ...entry.aliases].some((spelling) => key(spelling).includes(key(query.q!))),
      );
      return {
        makes: found.slice(0, query.limit ?? 50),
        total: found.length,
        nextCursor: found.length > (query.limit ?? 50) ? "next" : null,
      };
    },
  } as unknown as ApiClient;
  return { client, asked };
}

describe("«выбор с поиском» (TASK-035.B)", () => {
  it("asks the server for what is typed, trimmed; too little — the first entries", () => {
    expect(searchQuery("  джили  ")).toBe("джили");
    expect(searchQuery("geely   auto")).toBe("geely auto");
    expect(searchQuery("   ")).toBe("");
    expect(searchQuery("g")).toBe("g");
  });

  it("finds an entry beyond the first hundred by searching the server, never by loading the list", async () => {
    const { client, asked } = fakeServer();
    const makes = createChoiceSources(client).makes("active");
    // Browsing shows one page only — not the whole list, not the first hundred.
    const first = await makes("");
    expect(first).toHaveLength(SEARCH_PAGE);
    expect(first.map((choice) => choice.label)).not.toContain("Марка 148");
    // The last make of 150 and one by another spelling are found by typing.
    expect((await makes("148")).map((choice) => choice.label)).toEqual(["Марка 148"]);
    expect(await makes("джили")).toEqual([
      expect.objectContaining({ label: "Geely", note: "Джили, GEELY Auto" }),
    ]);
    expect(await makes("geelyauto")).toHaveLength(1);
    expect(asked.every((query) => (query.limit ?? 0) <= SEARCH_PAGE)).toBe(true);
    expect(asked.map((query) => query.q)).toEqual([undefined, "148", "джили", "geelyauto"]);
  });

  it("moves through the list by the keyboard, wrapping around", () => {
    expect(moveActive(-1, 3, "ArrowDown")).toBe(0);
    expect(moveActive(2, 3, "ArrowDown")).toBe(0);
    expect(moveActive(0, 3, "ArrowUp")).toBe(2);
    expect(moveActive(-1, 3, "ArrowUp")).toBe(2);
    expect(moveActive(1, 3, "Home")).toBe(0);
    expect(moveActive(0, 3, "End")).toBe(2);
    expect(moveActive(0, 20, "PageDown")).toBe(5);
    expect(moveActive(18, 20, "PageDown")).toBe(19);
    expect(moveActive(3, 20, "PageUp")).toBe(0);
    expect(moveActive(0, 0, "ArrowDown")).toBe(-1);
  });

  it("keeps «Любой» first and the chosen entry findable while nothing is typed", () => {
    const geely = { id: "g", label: "Geely" };
    const chery = { id: "c", label: "Chery" };
    const archived = { id: "a", label: "Старая марка", muted: true };
    expect(listed([geely, chery], { typed: false, empty: "Любой", chosen: geely })).toEqual([
      null,
      geely,
      chery,
    ]);
    // The chosen one isn't among the first entries (archived, or further on): it's still there.
    expect(listed([geely], { typed: false, empty: "Любой", chosen: archived })).toEqual([
      null,
      archived,
      geely,
    ]);
    // Typing shows only what was found.
    expect(listed([chery], { typed: true, empty: "Любой", chosen: archived })).toEqual([chery]);
    expect(listed([], { typed: false })).toEqual([]);
  });

  it("offers «Новый …» with what is typed, highlighted when nothing was found (TASK-035.C)", () => {
    expect(createText("Новый двигатель", "H4J")).toBe("Новый двигатель «H4J»");
    expect(createText("Новый бренд", "")).toBe("Новый бренд");
    // Typed, nothing found: the «new value» entry is the only one — Enter opens its form.
    expect(firstActive({ typed: true, found: 0, canCreate: true })).toBe(0);
    // Typed and found: the best match, as before; the entry stays last for a click or End.
    expect(firstActive({ typed: true, found: 3, canCreate: true })).toBe(0);
    expect(firstActive({ typed: true, found: 0, canCreate: false })).toBe(-1);
    // Browsing: nothing highlighted until the keyboard moves.
    expect(firstActive({ typed: false, found: 20, canCreate: true })).toBe(-1);
    // The entry is one more stop of the keyboard: End reaches it after 3 found.
    expect(moveActive(0, 3 + 1, "End")).toBe(3);
  });

  it("says what an engine and a generation are besides their names", () => {
    const engine = {
      id: "e",
      code: "JLH-3G15TD",
      aliases: ["3G15TD"],
      displacementL: 1.5,
      powerHp: 177,
      fuel: {
        id: "f",
        kind: "fuel",
        code: "petrol",
        names: { ru: "Бензин", kk: null, en: null },
        status: "active",
      },
      status: "archived",
    } as AdminVehicleEngine;
    expect(engineChoice(engine)).toEqual({
      id: "e",
      label: "JLH-3G15TD",
      note: "1,5 л · 177 л.с. · Бензин · 3G15TD · в архиве",
      muted: true,
    });
    expect(
      generationChoice({
        id: "g",
        name: "II (FX11)",
        yearFrom: 2023,
        yearTo: null,
        status: "active",
      } as Parameters<typeof generationChoice>[0]),
    ).toMatchObject({ label: "II (FX11) (2023–н.в.)", note: null, muted: false });
  });

  it("searches brands of every status for a filter and only active ones for a choice", async () => {
    const asked: unknown[] = [];
    const client = {
      listAdminBrands: async ({ query }: { query: unknown }) => {
        asked.push(query);
        return {
          brands: [
            {
              id: "b",
              name: "TRW",
              aliases: [],
              status: "archived",
              isOem: false,
            } as unknown as AdminBrand,
          ],
          nextCursor: null,
        };
      },
    } as unknown as ApiClient;
    const sources = createChoiceSources(client);
    expect(await sources.brands()("trw")).toEqual([
      { id: "b", label: "TRW", note: "в архиве", muted: true },
    ]);
    await sources.brands("active")("");
    expect(asked).toEqual([
      { q: "trw", status: undefined, limit: SEARCH_PAGE },
      { status: "active", limit: SEARCH_PAGE },
    ]);
  });
});
