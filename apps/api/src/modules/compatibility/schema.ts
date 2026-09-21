import { boolean, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  CompatibilityProposalResolution,
  CompatibilityProposalSource,
  CompatibilityProposalStatus,
  CompatibilityRecordStatus,
  CompatibilitySource,
} from "@adclub/contracts";

/**
 * Drizzle mirrors of the compatibility tables (`infra/migrations`,
 * `…_create-item-compatibility.sql` — the source of truth, with the checks,
 * unique keys and triggers that hold the rules; ARCHITECTURE 5.3, 4.25).
 */

type GoodsType = "part" | "generic";

/** The levels a record or a proposal names; `null` — «any». */
const levels = () => ({
  makeId: uuid("make_id").notNull(),
  modelId: uuid("model_id"),
  generationId: uuid("generation_id"),
  bodyTypeId: uuid("body_type_id"),
  bodyTypeKind: text("body_type_kind").notNull().default("body"),
  engineId: uuid("engine_id"),
  transmissionTypeId: uuid("transmission_type_id"),
  transmissionTypeKind: text("transmission_type_kind").notNull().default("transmission"),
  driveTypeId: uuid("drive_type_id"),
  driveTypeKind: text("drive_type_kind").notNull().default("drive"),
  yearFrom: smallint("year_from"),
  yearTo: smallint("year_to"),
});

export const itemCompatibility = pgTable("item_compatibility", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  itemType: text("item_type").$type<GoodsType>().notNull(),
  ...levels(),
  status: text("status").$type<CompatibilityRecordStatus>().notNull().default("approved"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  source: text("source").$type<CompatibilitySource>().notNull(),
  evidence: text("evidence").notNull(),
  copiedFromId: uuid("copied_from_id"),
  createdByAccountId: uuid("created_by_account_id"),
  reviewedByAdminId: uuid("reviewed_by_admin_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const itemCompatibilityProposal = pgTable("item_compatibility_proposal", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull(),
  itemType: text("item_type").$type<GoodsType>().notNull(),
  ...levels(),
  evidence: text("evidence").notNull(),
  source: text("source").$type<CompatibilityProposalSource>().notNull(),
  supplierId: uuid("supplier_id"),
  supplierMemberId: uuid("supplier_member_id"),
  proposedByAccountId: uuid("proposed_by_account_id"),
  status: text("status").$type<CompatibilityProposalStatus>().notNull().default("pending"),
  resolution: text("resolution").$type<CompatibilityProposalResolution>(),
  approvedWithChanges: boolean("approved_with_changes").notNull().default(false),
  compatibilityId: uuid("compatibility_id"),
  rejectionReason: text("rejection_reason"),
  reviewedByAdminId: uuid("reviewed_by_admin_id"),
  reviewedByAccountId: uuid("reviewed_by_account_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ItemCompatibilityRow = typeof itemCompatibility.$inferSelect;
export type ItemCompatibilityProposalRow = typeof itemCompatibilityProposal.$inferSelect;

export const compatibilityTables = [itemCompatibility, itemCompatibilityProposal];
