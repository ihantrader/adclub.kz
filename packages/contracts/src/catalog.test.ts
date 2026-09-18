import { describe, expect, it } from "vitest";
import {
  CATALOG_CLIENT_CACHE_SECONDS,
  CATEGORY_NAME_MAX_LENGTH,
  categoryIcons,
  createAttributeBodySchema,
  createCategoryBodySchema,
  reorderAttributeOptionsBodySchema,
  reorderAttributesBodySchema,
  reorderCategoriesBodySchema,
  updateAttributeBodySchema,
  updateCategoryBodySchema,
} from "./catalog";

describe("catalog contract", () => {
  it("requires a Russian name and allows Kazakh and English to wait", () => {
    expect(
      createCategoryBodySchema.safeParse({
        code: "brakes",
        kind: "goods",
        names: { ru: "Тормоза" },
      }).success,
    ).toBe(true);
    expect(
      createCategoryBodySchema.safeParse({
        code: "brakes",
        kind: "goods",
        names: { kk: "Тежегіштер" },
      }).success,
    ).toBe(false);
    // Russian can't be cleared in a change; the others can.
    expect(
      updateCategoryBodySchema.safeParse({ expectedVersion: 1, names: { ru: null } }).success,
    ).toBe(false);
    expect(
      updateCategoryBodySchema.safeParse({ expectedVersion: 1, names: { kk: null, en: null } })
        .success,
    ).toBe(true);
  });

  it("limits a category name to two lines of a tile, in every language", () => {
    const name = (length: number) => ({
      code: "long_name",
      kind: "goods",
      names: { ru: "Т", kk: "қ".repeat(length) },
    });
    expect(CATEGORY_NAME_MAX_LENGTH).toBe(40);
    expect(createCategoryBodySchema.safeParse(name(40)).success).toBe(true);
    expect(createCategoryBodySchema.safeParse(name(41)).success).toBe(false);
    // Surrounding spaces don't count, control characters are refused.
    expect(
      createCategoryBodySchema.safeParse({ ...name(1), names: { ru: `  ${"т".repeat(40)}  ` } })
        .success,
    ).toBe(true);
    expect(createCategoryBodySchema.safeParse({ ...name(1), names: { ru: "a\nb" } }).success).toBe(
      false,
    );
  });

  it("takes only icons of the set and snake_case codes", () => {
    const base = { kind: "goods", names: { ru: "Тормоза" } };
    expect(
      createCategoryBodySchema.safeParse({ ...base, code: "brakes", icon: "disc" }).success,
    ).toBe(true);
    expect(
      createCategoryBodySchema.safeParse({ ...base, code: "brakes", icon: "rocket" }).success,
    ).toBe(false);
    for (const code of ["Brakes", "1brakes", "b", "brake-pads", "тормоза"]) {
      expect(createCategoryBodySchema.safeParse({ ...base, code }).success, code).toBe(false);
    }
    expect(new Set(categoryIcons).size).toBe(categoryIcons.length);
    for (const icon of categoryIcons) {
      expect(icon).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("describes the four attribute types and accepts the type in a change only to refuse it", () => {
    for (const valueType of ["number", "enum", "bool", "text"]) {
      expect(
        createAttributeBodySchema.safeParse({ code: "size", valueType, names: { ru: "Размер" } })
          .success,
      ).toBe(true);
    }
    expect(
      createAttributeBodySchema.safeParse({ code: "size", valueType: "range", names: { ru: "Р" } })
        .success,
    ).toBe(false);
    expect(
      updateAttributeBodySchema.parse({ expectedVersion: 2, valueType: "enum" }).valueType,
    ).toBe("enum");
  });

  it("lets clients and proxies keep an answer a minute at most", () => {
    expect(CATALOG_CLIENT_CACHE_SECONDS).toBeGreaterThan(0);
    expect(CATALOG_CLIENT_CACHE_SECONDS).toBeLessThanOrEqual(60);
  });

  it("takes the order a new order was made from, and keeps it optional (TASK-010.A)", () => {
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    const bodies = [
      (expectedOrder?: unknown) =>
        reorderCategoriesBodySchema.safeParse({
          parentId: null,
          kind: "goods",
          categoryIds: [b, a],
          ...(expectedOrder !== undefined && { expectedOrder }),
        }).success,
      (expectedOrder?: unknown) =>
        reorderAttributesBodySchema.safeParse({
          attributeIds: [b, a],
          ...(expectedOrder !== undefined && { expectedOrder }),
        }).success,
      (expectedOrder?: unknown) =>
        reorderAttributeOptionsBodySchema.safeParse({
          optionIds: [b, a],
          ...(expectedOrder !== undefined && { expectedOrder }),
        }).success,
    ];
    for (const parses of bodies) {
      expect(parses()).toBe(true);
      expect(parses([a, b])).toBe(true);
      expect(parses(["not-a-uuid"])).toBe(false);
      expect(parses("a,b")).toBe(false);
    }
  });
});
