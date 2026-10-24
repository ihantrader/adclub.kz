import * as contracts from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { statusRole, statusRoles, type StatusKind } from "./status-roles";

/**
 * Every status enum of the contract and the kind of `statusRoles` that
 * draws it. A new `…StatusSchema`/`…StateSchema` of the contract fails the
 * second test until it is put here and given its roles.
 */
const KIND_OF_SCHEMA: Record<string, StatusKind | "not a badge"> = {
  orderStatusSchema: "order",
  supplierFinishedStatusSchema: "order",
  supplierLeadStatusSchema: "supplierLead",
  supplierStateSchema: "supplier",
  reviewStatusSchema: "review",
  complaintStatusSchema: "complaint",
  adminSignalStatusSchema: "signal",
  vehicleImportStatusSchema: "vehicleImport",
  priceImportStatusSchema: "priceImport",
  catalogItemStatusSchema: "catalogItem",
  categoryStatusSchema: "category",
  catalogEntryStatusSchema: "entry",
  vehicleEntryStatusSchema: "entry",
  cityStatusSchema: "entry",
  itemPhotoStatusSchema: "photo",
  itemAnalogStatusSchema: "analog",
  catalogRequestStatusSchema: "catalogRequest",
  compatibilityProposalStatusSchema: "compatibilityProposal",
  compatibilityRecordStatusSchema: "compatibilityRecord",
  offerStatusSchema: "offer",
  clubAccessGrantStatusSchema: "clubAccessGrant",
  subscriptionStatusSchema: "subscription",
  supplierInvitationStatusSchema: "invitation",
  translationQueueStateSchema: "translation",
  // A match of a recognized vehicle document, not the state of a record.
  vehicleDocumentMatchStatusSchema: "not a badge",
};

interface EnumLike {
  options: readonly string[];
}

function isEnum(value: unknown): value is EnumLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "options" in value &&
    Array.isArray((value as EnumLike).options)
  );
}

const schemas = Object.entries(contracts).filter(
  ([name, value]) => /(Status|State)Schema$/.test(name) && isEnum(value),
) as [string, EnumLike][];

describe("statusRoles", () => {
  it("finds the status enums of the contract", () => {
    expect(schemas.length).toBeGreaterThanOrEqual(20);
  });

  it("knows every status enum of the contract", () => {
    const unknown = schemas.map(([name]) => name).filter((name) => !(name in KIND_OF_SCHEMA));
    expect(unknown).toEqual([]);
  });

  it("gives every status of the contract a role", () => {
    const missing: string[] = [];
    for (const [name, schema] of schemas) {
      const kind = KIND_OF_SCHEMA[name];
      if (!kind || kind === "not a badge") continue;
      const roles = statusRoles[kind] as Record<string, unknown>;
      for (const status of schema.options) {
        if (!(status in roles)) missing.push(`${name}.${status}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the outcomes of an order neutral, never red (DESIGN 7.8)", () => {
    for (const status of contracts.orderStatusSchema.options) {
      expect(statusRole("order", status).tone).not.toBe("danger");
    }
    expect(statusRole("order", "accepted").tone).toBe("accent");
    expect(statusRole("order", "ready").tone).toBe("success");
    expect(statusRole("order", "term_proposed").tone).toBe("warning");
    expect(statusRole("order", "completed").tone).toBe("neutral");
  });

  it("follows the roles of X7: active — success, new — warning, archived — neutral, failed — danger", () => {
    expect(statusRole("entry", "active").tone).toBe("success");
    expect(statusRole("supplierLead", "new").tone).toBe("warning");
    expect(statusRole("catalogItem", "archived").tone).toBe("neutral");
    expect(statusRole("vehicleImport", "failed").tone).toBe("danger");
    expect(statusRole("priceImport", "applied").tone).toBe("success");
    expect(statusRole("vehicleImport", "applied").tone).toBe("success");
  });

  it("draws a status it does not know (a newer server) as a neutral badge", () => {
    expect(statusRole("order", "something_new").tone).toBe("neutral");
  });
});
