import { describe, expect, it } from "vitest";
import {
  apiRoutes,
  auditActions,
  compatibilityCheckBodySchema,
  compatibilityConditionsInputSchema,
  createCompatibilityProposalBodySchema,
  errorCodeSchema,
  rateLimitNameSchema,
} from "./index";

const UUID = "3f1c2b6e-8a1d-4e2b-9c3a-1b2c3d4e5f60";

describe("compatibility contract (TASK-015)", () => {
  it("requires the make and leaves every other level optional", () => {
    expect(compatibilityConditionsInputSchema.safeParse({ makeId: UUID }).success).toBe(true);
    expect(compatibilityConditionsInputSchema.safeParse({ modelId: UUID }).success).toBe(false);
    expect(
      compatibilityConditionsInputSchema.safeParse({ makeId: UUID, yearFrom: 1899 }).success,
    ).toBe(false);
  });

  it("takes grounds with line breaks, not with other control characters or empty", () => {
    const body = (evidence: string) =>
      createCompatibilityProposalBodySchema.safeParse({ conditions: { makeId: UUID }, evidence })
        .success;
    expect(body("Каталог TecDoc\nhttps://example.com/page")).toBe(true);
    expect(body("   ")).toBe(false);
    expect(body(`bell${String.fromCharCode(7)}`)).toBe(false);
    expect(body("x".repeat(1001))).toBe(false);
  });

  it("checks at most 500 items by id", () => {
    const ids = (n: number) => Array.from({ length: n }, () => UUID);
    expect(compatibilityCheckBodySchema.safeParse({ itemIds: ids(500) }).success).toBe(true);
    expect(compatibilityCheckBodySchema.safeParse({ itemIds: ids(501) }).success).toBe(false);
    expect(compatibilityCheckBodySchema.safeParse({ itemIds: [] }).success).toBe(false);
  });

  it("serves records and moderation to admin, proposals to supplier, the check to everyone", () => {
    const routes = Object.values(apiRoutes);
    const contextsOf = (operationId: string) => {
      const route = routes.find((entry) => entry.operationId === operationId)!;
      return "contexts" in route ? route.contexts.join() : "public";
    };
    for (const operationId of [
      "getItemCompatibility",
      "createCompatibilityRecord",
      "copyCompatibility",
      "updateCompatibilityRecord",
      "archiveCompatibilityRecord",
      "listCompatibilityProposals",
      "approveCompatibilityProposal",
      "rejectCompatibilityProposal",
    ]) {
      expect(contextsOf(operationId)).toBe("admin");
    }
    for (const operationId of [
      "createCompatibilityProposal",
      "listSupplierCompatibilityProposals",
      "getSupplierCompatibilityProposal",
    ]) {
      expect(contextsOf(operationId)).toBe("supplier");
    }
    expect(contextsOf("checkCompatibility")).toBe("public");
    expect("auth" in apiRoutes.checkCompatibility).toBe(false);
  });

  it("adds the error codes, the journal actions and the rate limit", () => {
    for (const code of [
      "COMPATIBILITY_CONDITIONS_INVALID",
      "COMPATIBILITY_VEHICLE_INVALID",
      "COMPATIBILITY_VERSION_CONFLICT",
      "COMPATIBILITY_DUPLICATE",
      "COMPATIBILITY_NOT_APPLICABLE",
      "COMPATIBILITY_ITEM_ARCHIVED",
      "COMPATIBILITY_NOT_ANALOG",
      "COMPATIBILITY_PROPOSAL_STATE",
      "COMPATIBILITY_PROPOSAL_DUPLICATE",
    ]) {
      expect(errorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(auditActions.compatibilityProposalApproved).toBe("item_compatibility_proposal.approved");
    expect(rateLimitNameSchema.safeParse("compatibility_proposals_per_supplier").success).toBe(
      true,
    );
  });
});
