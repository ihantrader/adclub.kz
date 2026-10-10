import type { AdminSearchResponse } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { directEntry, headerQuery, searchEntries } from "./header-search";

const ORDER = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-000000000002";
const SUPPLIER = "00000000-0000-4000-8000-000000000003";

const answer = (patch: Partial<AdminSearchResponse> = {}): AdminSearchResponse => ({
  reading: { phoneDigits: null, orderNumber: null, bin: null, article: null, text: null },
  orders: [],
  users: [],
  members: [],
  suppliers: [],
  leads: [],
  items: [],
  ...patch,
});

describe("the header's search (A-SEARCH, TASK-036.B)", () => {
  it("lays the server's groups out in one list, each entry with where it opens", () => {
    const entries = searchEntries(
      answer({
        reading: { phoneDigits: "1028", orderNumber: 1028, bin: null, article: null, text: null },
        orders: [
          {
            id: ORDER,
            number: 1028,
            status: "created",
            supplierName: "Автомаркет",
            total: 12500,
            createdAt: "2026-10-10T10:00:00.000Z",
          },
        ],
        users: [{ accountId: ACCOUNT, name: null, phone: "+7 747 *** ** 28" }],
        members: [
          {
            memberId: "00000000-0000-4000-8000-000000000004",
            supplierId: SUPPLIER,
            supplierName: "Автомаркет",
            displayName: "Айгерим",
            phone: "+7 705 *** ** 28",
            status: "active",
          },
        ],
      }),
    );
    expect(entries.map((entry) => [entry.group, entry.label, entry.href])).toEqual([
      ["Заявки", "№ 1028", `/orders/${ORDER}`],
      ["Пользователи", "Без имени", `/users/${ACCOUNT}`],
      ["Сотрудники поставщиков", "Айгерим", `/suppliers/${SUPPLIER}?tab=members`],
    ]);
    // «1028» and Enter: straight into the order of that number, not the first user.
    expect(
      directEntry(
        answer({
          reading: { phoneDigits: "1028", orderNumber: 1028, bin: null, article: null, text: null },
          orders: [
            {
              id: ORDER,
              number: 1028,
              status: "created",
              supplierName: "Автомаркет",
              total: 12500,
              createdAt: "2026-10-10T10:00:00.000Z",
            },
          ],
        }),
        entries,
      )?.href,
    ).toBe(`/orders/${ORDER}`);
  });

  it("goes to the only entry, and nowhere when there are several and no order's number", () => {
    const one = searchEntries(
      answer({
        suppliers: [{ id: SUPPLIER, name: "Автомаркет", bin: "080740000128", cityName: "Алматы" }],
      }),
    );
    expect(directEntry(answer(), one)?.href).toBe(`/suppliers/${SUPPLIER}`);
    expect(one[0]!.note).toBe("Алматы · БИН 080740000128");
    expect(directEntry(answer(), [])).toBeNull();
  });

  it("asks the server for the line trimmed, nothing for an empty one", () => {
    expect(headerQuery("  №  1028 ")).toBe("№ 1028");
    expect(headerQuery("   ")).toBe("");
  });
});
