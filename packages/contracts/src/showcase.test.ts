import { describe, expect, it } from "vitest";
import {
  apiRoutes,
  buildOpenApiDocument,
  grantClubAccessBodySchema,
  showcaseListQuerySchema,
  showcaseOfferSupplierSchema,
} from "./index";

const UUID = "3f1c2b6e-8a1d-4e2b-9c3a-1b2c3d4e5f60";
const OTHER = "4a2d3c7f-9b2e-4f3c-8d4b-2c3d4e5f6071";

describe("the catalog for users (TASK-020)", () => {
  it("takes attribute filters as one JSON parameter and brands separated by commas", () => {
    const parsed = showcaseListQuerySchema.parse({
      attributes: JSON.stringify([
        { attributeId: UUID, optionIds: [OTHER] },
        { attributeId: OTHER, min: 1, max: 4.5 },
        { attributeId: UUID, value: true },
      ]),
      brandIds: `${UUID}, ${OTHER},`,
      limit: "10",
    });
    expect(parsed.attributes).toHaveLength(3);
    expect(parsed.brandIds).toEqual([UUID, OTHER]);
    expect(parsed.limit).toBe(10);
  });

  it("refuses a filter with no kind or two kinds, a reversed range and broken JSON", () => {
    for (const attributes of [
      [{ attributeId: UUID }],
      [{ attributeId: UUID, optionIds: [OTHER], value: true }],
      [{ attributeId: UUID, min: 5, max: 1 }],
    ]) {
      expect(
        showcaseListQuerySchema.safeParse({ attributes: JSON.stringify(attributes) }).success,
      ).toBe(false);
    }
    expect(showcaseListQuerySchema.safeParse({ attributes: "[nope" }).success).toBe(false);
    expect(showcaseListQuerySchema.safeParse({ brandIds: "not-a-uuid" }).success).toBe(false);
    expect(showcaseListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
  });

  it("has nothing in a hidden supplier but the sign and its reason", () => {
    expect(showcaseOfferSupplierSchema.parse({ kind: "hidden", reason: "auth_required" })).toEqual({
      kind: "hidden",
      reason: "auth_required",
    });
    // Anything else a server might add by mistake is not part of the variant.
    expect(
      showcaseOfferSupplierSchema.parse({
        kind: "hidden",
        reason: "subscription_required",
        name: "X",
      }),
    ).toEqual({ kind: "hidden", reason: "subscription_required" });
    expect(showcaseOfferSupplierSchema.safeParse({ kind: "hidden" }).success).toBe(false);
  });

  it("opens the catalog to guests with an optional user session, and club access to admins only", () => {
    const document = buildOpenApiDocument(Object.values(apiRoutes));
    for (const path of ["/catalog/categories/{categoryId}/items", "/catalog/items/{itemId}"]) {
      const operation = document.paths[path]!.get!;
      expect(operation.security).toEqual([{}, { sessionAccessToken: [] }]);
      expect(operation["x-access-contexts"]).toEqual(["user"]);
    }
    for (const route of [
      apiRoutes.grantClubAccess,
      apiRoutes.revokeClubAccess,
      apiRoutes.listClubAccessGrants,
    ]) {
      expect(route).toMatchObject({ auth: "session", contexts: ["admin"] });
    }
    expect(
      grantClubAccessBodySchema.safeParse({
        phone: "+77011234567",
        validUntil: "2026-12-31T23:59:59+05:00",
        reason: " ",
      }).success,
    ).toBe(false);
  });
});
