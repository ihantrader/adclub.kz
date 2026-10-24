import { auditActions, type AuditActor } from "@adclub/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  actionText,
  actorLines,
  groupJournal,
  objectsText,
  visibleChangeText,
  actorText,
  almatyDayStart,
  changeLines,
  entityTitle,
  hiddenFieldsOf,
  entityLink,
  knownActions,
  numberText,
  reasonText,
  valueText,
} from "./audit-words";

/** The thousands separator of ru-RU (a no-break space). */
const GAP = (1000).toLocaleString("ru-RU").charAt(1);
/** The no-break space inside a moment. */
const NB = String.fromCharCode(160);

// The year of a moment is left out when it is the current one (TASK-080, X19):
// the tests read the journal as of 24 October 2026.
beforeAll(() => {
  vi.useFakeTimers({ now: new Date("2026-10-24T12:00:00+05:00"), toFake: ["Date"] });
});
afterAll(() => {
  vi.useRealTimers();
});

const actor = (overrides: Partial<AuditActor>): AuditActor => ({
  role: "admin",
  accountId: null,
  phoneMasked: null,
  name: null,
  adminId: null,
  supplierId: null,
  supplierMemberId: null,
  ...overrides,
});

describe("the words of the journal", () => {
  it("names every action the contract knows in Russian, and an unknown one as it is", () => {
    for (const action of Object.values(auditActions)) {
      expect(knownActions, action).toContain(action);
      expect(actionText(action)).not.toBe(action);
    }
    expect(actionText("setting.changed")).toBe("Изменена настройка");
    expect(actionText("something.new")).toBe("something.new");
  });

  it("says reviews and complaints in words (TASK-049)", () => {
    expect(reasonText("review.text_rejected", "personal_data")).toBe("личные данные");
    expect(reasonText("review.hidden", "Проверено")).toBe("Проверено");
    expect(valueText("ai:profanity", "reasons")).toBe("[AI] мат или оскорбления");
    expect(valueText("rule:supplier_name", "reasons")).toBe("название поставщика");
    expect(valueText("not_received", "reason")).toBe("Не получил товар или услугу");
    expect(valueText("held", "status", { entityType: "review" })).toBe("На проверке");
    expect(valueText("in_progress", "status", { entityType: "complaint" })).toBe("В работе");
    expect(
      entityLink("review", "11111111-1111-4111-8111-111111111111", {
        after: { orderId: "22222222-2222-4222-8222-222222222222" },
      }),
    ).toBe("/orders/22222222-2222-4222-8222-222222222222");
    expect(entityLink("complaint", "33333333-3333-4333-8333-333333333333")).toBe(
      "/complaints/33333333-3333-4333-8333-333333333333",
    );
  });

  it("names who acted by name and the partly hidden number, never more", () => {
    expect(actorText(actor({ name: "Айгерим", phoneMasked: "+7***4567" }))).toBe(
      "Айгерим · +7***4567",
    );
    expect(actorText(actor({ role: "user", phoneMasked: "+7***1212" }))).toBe("+7***1212");
    expect(actorText(actor({ role: "operator" }))).toBe("Оператор сервера");
    expect(actorText(actor({ role: "system" }))).toBe("Система");
    expect(actorText(actor({ role: "supplier" }))).toBe("Сотрудник поставщика");
  });

  it("shows «было → стало» field by field, only what changed", () => {
    expect(
      changeLines({ value: 2, isDefault: true }, { value: 5, isDefault: false, version: 1 }),
    ).toEqual([
      { field: "Значение", before: "2", after: "5" },
      { field: "По умолчанию", before: "да", after: "нет" },
      { field: "Версия", before: "—", after: "1", technical: true },
    ]);
    expect(changeLines(null, null)).toEqual([]);
    expect(changeLines(null, { status: "closed" }, [], { entityType: "admin_signal" })).toEqual([
      { field: "Статус", before: "—", after: "Закрыт" },
    ]);
    expect(changeLines(3, 4)).toEqual([{ field: null, before: "3", after: "4" }]);
  });

  it("doesn't show the market of a modification (TASK-035.C)", () => {
    const hidden = hiddenFieldsOf("vehicle_modification");
    expect(
      changeLines(null, { yearFrom: 2024, market: "kz" }, hidden).map((line) => line.field),
    ).toEqual(["Год с"]);
    expect(
      changeLines({ market: "kz", version: 1 }, { market: "global", version: 2 }, hidden),
    ).toEqual([{ field: "Версия", before: "1", after: "2", technical: true }]);
    expect(hiddenFieldsOf("vehicle_engine")).toEqual([]);
  });

  it("writes years, БИН, numbers and versions without the thousands apart, amounts with (TASK-036)", () => {
    expect(changeLines({ yearFrom: 2019, yearTo: null }, { yearFrom: 2025, yearTo: 2026 })).toEqual(
      [
        { field: "Год с", before: "2019", after: "2025" },
        { field: "Год по", before: "пусто", after: "2026" },
      ],
    );
    expect(changeLines(null, { orderNumber: 10421, version: 1203, price: 12500 })).toEqual([
      { field: "Номер заявки", before: "—", after: "10421" },
      { field: "Версия", before: "—", after: "1203", technical: true },
      { field: "Цена", before: "—", after: `12${GAP}500` },
    ]);
    expect(numberText(2025, "year")).toBe("2025");
    expect(numberText(2025, "contractYear")).toBe("2025");
    expect(numberText(2025, "itemId")).toBe("2025");
    expect(numberText(2025, "sessionsEnded")).toBe(`2${GAP}025`);
    expect(numberText(2025)).toBe(`2${GAP}025`);
  });

  it("opens a supplier, its employees and invitations, and a connection request (TASK-036)", () => {
    const id = "0b6c9f1e-2a3d-4c5b-8e7f-9a0b1c2d3e4f";
    const other = "1c7d0a2f-3b4e-4d6c-9f80-0b1c2d3e4f50";
    expect(entityLink("supplier", id)).toBe(`/suppliers/${id}`);
    expect(entityLink("supplier_member", other, { after: { supplierId: id } })).toBe(
      `/suppliers/${id}?tab=members`,
    );
    expect(entityLink("supplier_member", other, { before: { supplierId: id } })).toBe(
      `/suppliers/${id}?tab=members`,
    );
    expect(entityLink("supplier_invitation", other, { after: { supplierId: id } })).toBe(
      `/suppliers/${id}?tab=members`,
    );
    expect(entityLink("supplier_member", other)).toBeNull();
    expect(entityLink("supplier_lead", id)).toBe(`/suppliers/leads/${id}`);
    expect(entityLink("supplier", "not-an-id")).toBeNull();
  });

  it("takes the period by the days of Almaty", () => {
    expect(almatyDayStart("2026-10-07")).toBe("2026-10-06T19:00:00.000Z");
    expect(almatyDayStart("2026-10-07", 1)).toBe("2026-10-07T19:00:00.000Z");
    expect(almatyDayStart("")).toBeUndefined();
  });

  it("links the objects whose section exists already", () => {
    expect(entityLink("setting", "supplier_response_hours")).toBe(
      "/settings/supplier_response_hours/history",
    );
    expect(entityLink("admin_signal", "x")).toBe("/signals");
    expect(entityLink("city", "x")).toBe("/settings/cities");
    expect(entityLink("order", "x")).toBeNull();
  });

  it("opens an order, a user, a grant of club access and a discipline mark (TASK-036.B)", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const order = "00000000-0000-4000-8000-000000000002";
    const account = "00000000-0000-4000-8000-000000000003";
    expect(entityLink("order", id)).toBe(`/orders/${id}`);
    expect(entityLink("account", account)).toBe(`/users/${account}`);
    expect(entityLink("club_access_grant", id, { after: { accountId: account } })).toBe(
      `/users/${account}?tab=access`,
    );
    // TASK-040: a subscription opens «Клубный доступ» of its user, its words are words.
    expect(entityLink("subscription", id, { after: { accountId: account } })).toBe(
      `/users/${account}?tab=access`,
    );
    expect(valueText("expired_unconfirmed", "status", { entityType: "subscription" })).toBe(
      "Статус не подтверждён",
    );
    expect(valueText("system", "changedBy")).toBe("система, по времени");
    expect(valueText("period_lapsed", "eventKind")).toBe("Срок прошёл без подтверждения");
    expect(
      entityLink("user_discipline_event", id, {
        before: { orderId: order },
        after: { accountId: account },
      }),
    ).toBe(`/orders/${order}`);
    expect(entityLink("user_discipline_event", id, { after: { accountId: account } })).toBe(
      `/users/${account}?tab=discipline`,
    );
  });

  describe("reads by names and words, not ids and codes (TASK-036.B)", () => {
    const city = "00000000-0000-4000-8000-000000000010";
    const other = "00000000-0000-4000-8000-000000000011";
    const account = "00000000-0000-4000-8000-000000000012";
    const names = { [city]: "Алматы", [other]: "Астана", [account]: "Айдана Проверка" };

    it("a company created: the city by its name, the technical ids only under «Подробнее»", () => {
      const lines = changeLines(
        null,
        {
          companyName: "Детали Юг",
          cityId: city,
          type: "goods",
          binMasked: "0807****0128",
          leadId: null,
        },
        [],
        { entityType: "supplier", names },
      );
      expect(lines).toEqual([
        { field: "Компания", before: "—", after: "Детали Юг" },
        { field: "Город", before: "—", after: "Алматы" },
        { field: "Тип", before: "—", after: "Товары" },
        { field: "БИН", before: "—", after: "0807****0128" },
        { field: "Заявка на подключение", before: "—", after: "пусто" },
      ]);
      expect(
        changeLines({ cityId: city }, { cityId: other }, [], { entityType: "supplier", names }),
      ).toEqual([{ field: "Город", before: "Алматы", after: "Астана" }]);
    });

    it("an employee restored: «Удалён → Активен», the date of the removal in words, ids technical", () => {
      const lines = changeLines(
        {
          supplierId: city,
          status: "removed",
          removedAt: "2026-10-09T14:52:21.581Z",
          removedByMemberId: other,
        },
        { status: "active", notificationsEnabled: true },
        [],
        { entityType: "supplier_member", names },
      );
      expect(
        lines
          .filter((line) => !line.technical)
          .map((line) => [line.field, line.before, line.after]),
      ).toEqual([
        ["Статус", "Удалён", "Активен"],
        ["Удалён", `9${NB}окт.,${NB}19:52`, "—"],
        ["Получает уведомления", "—", "да"],
      ]);
      // The company the employee belonged to and who removed them — under «Подробнее».
      expect(lines.filter((line) => line.technical).map((line) => line.field)).toEqual([
        "Компания",
        "removedByMemberId",
      ]);
    });

    it("a member added: the account technical, the number partly hidden, «Восстановлен — нет»", () => {
      const lines = changeLines(
        null,
        { supplierId: city, accountId: account, phoneMasked: "+7***0101", restored: false },
        [],
        { entityType: "supplier_member", names },
      );
      expect(
        lines.filter((line) => !line.technical).map((line) => `${line.field}: ${line.after}`),
      ).toEqual(["Компания: Алматы", "Телефон: +7***0101", "Восстановлен: нет"]);
      expect(lines.filter((line) => line.technical).map((line) => line.field)).toEqual([
        "accountId",
      ]);
    });

    it("a connection request moved: «Новая → Связались»; a note — technical", () => {
      expect(
        changeLines({ status: "new" }, { status: "contacted", version: 2 }, [], {
          entityType: "supplier_lead",
        }).filter((line) => !line.technical),
      ).toEqual([{ field: "Статус", before: "Новая", after: "Связались" }]);
      expect(
        changeLines(null, { noteId: other }, [], { entityType: "supplier_lead", names })[0]!
          .technical,
      ).toBe(true);
    });

    it("a supplier unblocked: «Блокировка → Активен»; an invitation again — «Повторно: да»", () => {
      expect(
        changeLines(
          { blocked: true, state: "blocked" },
          { blocked: false, state: "active", visibleOnShowcase: true, version: 4 },
          [],
          { entityType: "supplier" },
        ).filter((line) => !line.technical),
      ).toEqual([
        { field: "Блокировка", before: "да", after: "нет" },
        { field: "Состояние", before: "Блокировка", after: "Активен" },
        { field: "Видно клиентам", before: "—", after: "да" },
      ]);
      expect(
        changeLines(null, { supplierId: city, memberId: other, again: true }, [], {
          entityType: "supplier_invitation",
          names,
        }).filter((line) => !line.technical),
      ).toEqual([
        { field: "Компания", before: "—", after: "Алматы" },
        { field: "Повторно", before: "—", after: "да" },
      ]);
    });

    it("an order: its statuses and deadlines in words; an item: its status", () => {
      expect(
        changeLines({ status: "accepted" }, { number: 1028, status: "cancelled_by_admin" }, [], {
          entityType: "order",
        }),
      ).toEqual([
        { field: "Статус", before: "Принята", after: "Отменена администратором" },
        { field: "Номер", before: "—", after: "1028" },
      ]);
      expect(
        changeLines({ deadline: "response" }, { deadline: "reserve", minutes: 30 }, [], {
          entityType: "order",
        }).map((line) => line.after),
      ).toEqual(["резерв", "30"]);
      expect(
        changeLines({ status: "active" }, { status: "archived" }, [], {
          entityType: "catalog_item",
        }),
      ).toEqual([{ field: "Статус", before: "Активна", after: "В архиве" }]);
    });

    it("hours of the week and closed dates in words; an id the server can't name — «не найден»", () => {
      expect(
        valueText(
          [
            { day: 1, intervals: [{ from: "09:00", to: "18:00" }] },
            { day: 7, intervals: [] },
          ],
          "weeklyHours",
        ),
      ).toBe("Пн 09:00–18:00; Вс выходной");
      expect(valueText([{ date: "2026-12-16", note: "праздник" }], "closedDates")).toBe(
        "16.12.2026",
      );
      expect(valueText("2026-09-01", "contractSignedOn")).toBe("01.09.2026");
      expect(valueText(other, "cityId", { names: {} })).toBe("не найден");
      expect(valueText({ ru: "Колодки", kk: null }, "names")).toBe("Колодки");
    });

    it("names the object by the server's name, never by its id", () => {
      expect(entityTitle({ entityType: "supplier_member", entityName: "Айдана Проверка" })).toBe(
        "Сотрудник поставщика: Айдана Проверка",
      );
      expect(entityTitle({ entityType: "order", entityName: "№ 1028" })).toBe("Заявка: № 1028");
      expect(entityTitle({ entityType: "supplier", entityName: null })).toBe("Компания: не найден");
    });
  });

  it("opens a level of the vehicle catalog with what lies under it, and an import (TASK-035.B)", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const generation = "00000000-0000-4000-8000-000000000002";
    expect(entityLink("vehicle_make", id)).toBe(`/vehicles/makes/${id}`);
    expect(entityLink("vehicle_model", id)).toBe(`/vehicles/models/${id}`);
    expect(entityLink("vehicle_generation", id)).toBe(`/vehicles/generations/${id}`);
    expect(entityLink("vehicle_modification", id, { after: { generationId: generation } })).toBe(
      `/vehicles/generations/${generation}?highlight=${id}`,
    );
    expect(entityLink("vehicle_modification", id, { after: { status: "archived" } })).toBeNull();
    expect(entityLink("vehicle_option", id, { after: { kind: "body", order: [] } })).toBe(
      `/vehicles/options?kind=body&highlight=${id}`,
    );
    expect(entityLink("vehicle_import", id)).toBe(`/vehicles/imports/${id}`);
    expect(entityLink("vehicle_make", "not-an-id")).toBeNull();
  });

  it("opens a catalog object: an item's card, the tree on a node, an attribute or an option", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const item = "00000000-0000-4000-8000-000000000002";
    expect(entityLink("catalog_item", id)).toBe(`/catalog/items/${id}`);
    expect(entityLink("catalog_category", id)).toBe(`/catalog?node=${id}`);
    expect(entityLink("catalog_attribute", id)).toBe(`/catalog?attribute=${id}`);
    expect(entityLink("catalog_attribute_option", id)).toBe(`/catalog?option=${id}`);
    expect(entityLink("catalog_brand", id)).toBe(`/catalog/items?brandId=${id}`);
    expect(entityLink("catalog_item_photo", id, { after: { itemId: item } })).toBe(
      `/catalog/items/${item}?tab=photos`,
    );
    expect(entityLink("item_compatibility", id, { before: null, after: { itemId: item } })).toBe(
      `/catalog/items/${item}?tab=compatibility`,
    );
    expect(entityLink("catalog_translation", item, { after: { entityType: "catalog_item" } })).toBe(
      `/catalog/items/${item}?tab=translations`,
    );
    expect(entityLink("catalog_translation", id, { after: { entityType: "category" } })).toBe(
      `/catalog?node=${id}`,
    );
    // The reorder of a kind's nodes names the kind, not a category.
    expect(entityLink("catalog_category", "goods")).toBeNull();
    expect(entityLink("catalog_item_photo", id)).toBeNull();
  });
});

describe("the rows of the journal (TASK-080, X16)", () => {
  const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const JSON_LIKE = /[{}[\]"]/;
  const photo = "089fd017-0601-4d59-be11-23378782b2f5";
  const item = "11111111-2222-4333-8444-555555555555";

  /** Real shapes of entries the before-shots of the audit showed with ids and JSON. */
  const samples: { before: unknown; after: unknown; entityType: string }[] = [
    {
      entityType: "catalog_item",
      before: { values: { material: "organicheskie" } },
      after: { values: { material: "keramika" }, via: "fill" },
    },
    {
      entityType: "catalog_item",
      before: { values: { material: null } },
      after: { values: { material: "organicheskie" }, via: "item" },
    },
    {
      entityType: "catalog_item_photo",
      before: { status: "proposed", primaryPhotoId: null },
      after: { status: "approved", primaryPhotoId: photo },
    },
    {
      entityType: "catalog_item_photo",
      before: null,
      after: { itemId: item, width: 800, height: 800, sha256: "ab12", sourceType: "manual" },
    },
    {
      entityType: "item_compatibility",
      before: null,
      after: { itemId: item, source: "supplier", conditions: { makeId: item, yearFrom: 2023 } },
    },
    {
      entityType: "catalog_item",
      before: null,
      after: { status: "approved", analogItemId: item },
    },
  ];

  it("shows no id and no JSON in a row: they are only under «Подробнее»", () => {
    for (const sample of samples) {
      const lines = changeLines(sample.before, sample.after, [], { entityType: sample.entityType });
      for (const line of lines.filter((entry) => !entry.technical)) {
        const shown = `${line.field ?? ""} ${line.text ?? ""} ${line.before} ${line.after}`;
        expect(shown, JSON.stringify(sample)).not.toMatch(UUID_ANYWHERE);
        expect(shown, JSON.stringify(sample)).not.toMatch(JSON_LIKE);
      }
    }
  });

  it("says how many values of an item changed and puts each code under «Подробнее»", () => {
    const lines = changeLines(
      { values: { material: "organicheskie", wear: null } },
      { values: { material: "keramika", wear: true }, via: "fill" },
      [],
      { entityType: "catalog_item" },
    );
    expect(lines.filter((line) => !line.technical)).toEqual([
      { field: "Характеристики", before: "", after: "", text: "изменено значений: 2" },
    ]);
    const technical = lines.filter((line) => line.technical).map((line) => line.field);
    expect(technical).toEqual(["Характеристики · material", "Характеристики · wear", "via"]);
  });

  it("names the source of a compatibility and the status of an analog in words", () => {
    const compatibility = changeLines(null, { source: "supplier" }, [], {
      entityType: "item_compatibility",
    });
    expect(compatibility[0]?.after).toBe("предложение поставщика");
    const analog = changeLines(null, { status: "approved" }, [], { entityType: "catalog_item" });
    expect(analog[0]?.after).toBe("Подтверждено");
  });

  it("an unnamed id, a measurement and a service mark are technical; a named id is shown by its name", () => {
    const lines = changeLines(
      { primaryPhotoId: null, itemId: null },
      { primaryPhotoId: photo, itemId: item, width: 800 },
      [],
      { entityType: "catalog_item_photo", names: { [item]: "Колодки тормозные передние" } },
    );
    expect(lines.filter((line) => !line.technical)).toEqual([
      { field: "Позиция", before: "пусто", after: "Колодки тормозные передние" },
    ]);
    expect(lines.filter((line) => line.technical).map((line) => line.field)).toEqual([
      "primaryPhotoId",
      "width",
    ]);
  });

  it("groups alike entries in a row, and only neighbours", () => {
    const admin = actor({ role: "admin", accountId: "a1", name: "Юрий" });
    const entry = (id: string, at: string, overrides: Partial<Entry> = {}): Entry => ({
      id,
      action: "order.closed_by_admin",
      actor: admin,
      entityType: "order",
      entityId: "o1",
      reason: null,
      at,
      before: null,
      after: { subject: "order" },
      ...overrides,
    });
    type Entry = {
      id: string;
      action: string;
      actor: AuditActor;
      entityType: string;
      entityId: string;
      reason: string | null;
      at: string;
      before: unknown;
      after: unknown;
    };
    const entries = [
      entry("1", "2026-10-16T10:05:00Z"),
      entry("2", "2026-10-16T10:04:00Z"),
      entry("3", "2026-10-16T10:03:00Z"),
      entry("4", "2026-10-16T10:02:00Z", { action: "order.deadline_extended" }),
      entry("5", "2026-10-16T10:01:00Z"),
      entry("6", "2026-10-16T10:00:00Z", { entityId: "o2" }),
    ];
    const groups = groupJournal(entries, visibleChangeText);
    expect(groups.map((group) => [group.entry.id, group.count, group.firstAt])).toEqual([
      ["1", 3, "2026-10-16T10:03:00Z"],
      ["4", 1, "2026-10-16T10:02:00Z"],
      ["5", 1, "2026-10-16T10:01:00Z"],
      ["6", 1, "2026-10-16T10:00:00Z"],
    ]);
    // Another person, or another visible change, is never folded in.
    const other = groupJournal(
      [
        entry("1", "2026-10-16T10:05:00Z"),
        entry("2", "2026-10-16T10:04:00Z", { actor: actor({ accountId: "a2" }) }),
      ],
      visibleChangeText,
    );
    expect(other).toHaveLength(2);
    const changed = groupJournal(
      [
        entry("1", "2026-10-16T10:05:00Z", { after: { status: "accepted" } }),
        entry("2", "2026-10-16T10:04:00Z", { after: { status: "ready" } }),
      ],
      visibleChangeText,
    );
    expect(changed).toHaveLength(2);
    // A repeated event over several objects (the buyer's phone of order after
    // order) is one row with its objects, newest first, each once.
    const phones = groupJournal(
      [
        {
          ...entry("1", "2026-10-16T10:05:00Z"),
          action: "order.phone_revealed",
          entityId: "o3",
          entityName: "№ 1117",
          after: { orderNumber: 1117 },
        },
        {
          ...entry("2", "2026-10-16T10:04:00Z"),
          action: "order.phone_revealed",
          entityId: "o2",
          entityName: "№ 1112",
          after: { orderNumber: 1112 },
        },
        {
          ...entry("3", "2026-10-16T10:03:00Z"),
          action: "order.phone_revealed",
          entityId: "o2",
          entityName: "№ 1112",
          after: { orderNumber: 1112 },
        },
        {
          ...entry("4", "2026-10-16T10:02:00Z"),
          action: "order.phone_revealed",
          entityId: "o1",
          entityName: "№ 1108",
          after: { orderNumber: 1108 },
        },
      ],
      visibleChangeText,
    );
    expect(phones).toHaveLength(1);
    expect(phones[0]).toMatchObject({ count: 4, objects: ["№ 1117", "№ 1112", "№ 1108"] });
    expect(objectsText(["№ 1", "№ 2", "№ 3", "№ 4", "№ 5"])).toBe("№ 1, № 2, № 3 и ещё 2");
  });

  it("names who acted by name, the role under it; without a name — the role, the mask under it", () => {
    expect(actorLines(actor({ name: "Юрий", phoneMasked: "+7***0034" }))).toEqual({
      name: "Юрий",
      note: "Администратор",
    });
    expect(actorLines(actor({ phoneMasked: "+7***0034" }))).toEqual({
      name: "Администратор",
      note: "+7***0034",
    });
    expect(actorLines(actor({ role: "system" }))).toEqual({ name: "Система", note: null });
  });

  it("a moment is one line, without the current year", () => {
    expect(valueText("2026-10-16T10:32:00Z")).toBe(`16${NB}окт.,${NB}15:32`);
    expect(valueText("2025-10-16T10:32:00Z")).toBe(`16${NB}окт.${NB}2025,${NB}15:32`);
  });
});
