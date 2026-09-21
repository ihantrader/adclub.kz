import { z } from "zod";

/**
 * The action journal (`audit_log`, ARCHITECTURE 5.12, 15.3; TASK-009):
 * significant actions of people — an administrator, a supplier employee, a
 * user changing someone else's data or rights, and the server operator
 * command. Technical events (a session issued at an ordinary sign-in) stay
 * in the application log.
 *
 * Entries are written and never changed; they are read by the admin panel
 * only (SCREENS, TASK-034). `before`/`after` keep the values as they are —
 * this is the database in Kazakhstan, not monitoring (PRODUCT 17).
 */

/**
 * Every action the journal knows. An action is `<entity>.<what happened>`;
 * new ones are added by the task that introduces them and nothing is ever
 * renamed, so old entries stay readable and a filter keeps working.
 */
export const auditActions = {
  /** A setting was given a new value (`before`/`after`: the value in effect). */
  settingChanged: "setting.changed",
  /** A setting was returned to its default. */
  settingReset: "setting.reset",
  /** A number was appointed an administrator (operator command, D-045). */
  adminGranted: "admin.granted",
  /** An administrator was removed; their admin sessions ended with it. */
  adminRemoved: "admin.removed",
  /** An administrator's second factor was reset (by another administrator or the operator). */
  adminTotpReset: "admin.totp_reset",
  /** An administrator replaced their own backup codes. */
  adminBackupCodesRegenerated: "admin.backup_codes_regenerated",
  /** A company was created (development operator command until TASK-016). */
  supplierCreated: "supplier.created",
  /** An employee was added to a company (development operator command until TASK-017). */
  supplierMemberAdded: "supplier_member.added",
  /** An employee was removed; their cabinet sessions of that company ended with it. */
  supplierMemberRemoved: "supplier_member.removed",
  /** A category was created (TASK-010). `after`: the category. */
  catalogCategoryCreated: "catalog_category.created",
  /** Names, icon, compatibility flag or parent changed. `before`/`after`: the changed fields. */
  catalogCategoryChanged: "catalog_category.changed",
  /** Hidden, archived or restored. `before`/`after`: `{ status }`. */
  catalogCategoryStatusChanged: "catalog_category.status_changed",
  /**
   * Siblings put in a new order. The entity is the parent category, or
   * `goods`/`services` for the nodes of a kind; `before`/`after`: the ids in order.
   */
  catalogCategoriesReordered: "catalog_category.reordered",
  catalogAttributeCreated: "catalog_attribute.created",
  catalogAttributeChanged: "catalog_attribute.changed",
  /** Archived or restored. */
  catalogAttributeStatusChanged: "catalog_attribute.status_changed",
  /** The attributes of a category put in a new order; the entity is the category. */
  catalogAttributesReordered: "catalog_attribute.reordered",
  catalogAttributeOptionCreated: "catalog_attribute_option.created",
  catalogAttributeOptionChanged: "catalog_attribute_option.changed",
  catalogAttributeOptionStatusChanged: "catalog_attribute_option.status_changed",
  /** The options of an attribute put in a new order; the entity is the attribute. */
  catalogAttributeOptionsReordered: "catalog_attribute_option.reordered",
  /** A brand was created (TASK-011). `after`: name, spellings, OEM flag. */
  catalogBrandCreated: "catalog_brand.created",
  /** Name, spellings or OEM flag changed. `before`/`after`: the changed fields. */
  catalogBrandChanged: "catalog_brand.changed",
  /** Archived or restored. */
  catalogBrandStatusChanged: "catalog_brand.status_changed",
  /** An item was created. `after`: the item with its values (by attribute code). */
  catalogItemCreated: "catalog_item.created",
  /** Category, brand, article or names changed. `before`/`after`: the changed fields. */
  catalogItemChanged: "catalog_item.changed",
  /** Draft, active or archived. */
  catalogItemStatusChanged: "catalog_item.status_changed",
  /**
   * Attribute values of one item changed, by attribute code (a list value
   * by option code, `null` — emptied); `via`: `item` (its card) or `fill`
   * (the bulk fill, one entry per item touched).
   */
  catalogItemValuesChanged: "catalog_item.values_changed",
  /** Two items were linked as analogs; one entry, on the item the link was made from. */
  catalogItemAnalogLinked: "catalog_item.analog_linked",
  catalogItemAnalogUnlinked: "catalog_item.analog_unlinked",
  /**
   * An administrator wrote a translation by hand (TASK-012). The entity is
   * the thing translated (`entityId`); `before`/`after`: `entityType`,
   * `field`, `lang` and the text.
   */
  catalogTranslationEdited: "catalog_translation.edited",
  /** A manual edit was released: the language is under automatic translation again. */
  catalogTranslationReleased: "catalog_translation.released",
  /** "Translate again" was asked for a language (or one without a translation). */
  catalogTranslationRequeued: "catalog_translation.requeued",
  /**
   * A photo was uploaded for an item and waits for approval (TASK-013).
   * `after`: source, size and checksum — never the picture itself.
   */
  catalogItemPhotoUploaded: "catalog_item_photo.uploaded",
  /**
   * A photo was approved, refused (with the reason) or removed.
   * `before`/`after`: `{ status }`, the reason and the primary photo of the
   * item if the role moved.
   */
  catalogItemPhotoStatusChanged: "catalog_item_photo.status_changed",
  /** The photos of an item put in a new order; the entity is the item. */
  catalogItemPhotosReordered: "catalog_item_photo.reordered",
  /**
   * The vehicle catalog (TASK-014). `created`: the record; `changed`:
   * `before`/`after` with the changed fields and the new version;
   * `status_changed`: archived or restored.
   */
  vehicleOptionCreated: "vehicle_option.created",
  vehicleOptionChanged: "vehicle_option.changed",
  vehicleOptionStatusChanged: "vehicle_option.status_changed",
  vehicleMakeCreated: "vehicle_make.created",
  vehicleMakeChanged: "vehicle_make.changed",
  vehicleMakeStatusChanged: "vehicle_make.status_changed",
  vehicleModelCreated: "vehicle_model.created",
  /** Also a move to another make (`makeId`). */
  vehicleModelChanged: "vehicle_model.changed",
  vehicleModelStatusChanged: "vehicle_model.status_changed",
  vehicleGenerationCreated: "vehicle_generation.created",
  /** Also a move to another model (`modelId`). */
  vehicleGenerationChanged: "vehicle_generation.changed",
  vehicleGenerationStatusChanged: "vehicle_generation.status_changed",
  vehicleEngineCreated: "vehicle_engine.created",
  vehicleEngineChanged: "vehicle_engine.changed",
  vehicleEngineStatusChanged: "vehicle_engine.status_changed",
  vehicleModificationCreated: "vehicle_modification.created",
  vehicleModificationChanged: "vehicle_modification.changed",
  vehicleModificationStatusChanged: "vehicle_modification.status_changed",
  /** A file was uploaded for import. `after`: file name, size, checksum, rows. */
  vehicleImportUploaded: "vehicle_import.uploaded",
  /** The administrator confirmed the report; applying began. `after`: the planned counts. */
  vehicleImportApplyStarted: "vehicle_import.apply_started",
  /**
   * Applying finished (written by the worker for the administrator who
   * confirmed it). `after`: what was created, updated, unchanged and
   * rejected. What each row did is kept with the import's rows, and every
   * record it created carries the import (`importId`).
   */
  vehicleImportApplied: "vehicle_import.applied",
  /** The administrator declined the import before it was applied. */
  vehicleImportCancelled: "vehicle_import.cancelled",
  /** The check or the application broke off (`after.error`). */
  vehicleImportFailed: "vehicle_import.failed",
  /**
   * Compatibility of items (TASK-015). A record: `created` (by hand, from
   * a proposal, or copied from an analog — `after.source`), `changed`,
   * `archived`. A proposal: `created` (by the supplier), `approved`
   * (`after.recordId`, `after.resolution`), `rejected` (`reason`).
   */
  itemCompatibilityCreated: "item_compatibility.created",
  itemCompatibilityChanged: "item_compatibility.changed",
  itemCompatibilityArchived: "item_compatibility.archived",
  compatibilityProposalCreated: "item_compatibility_proposal.created",
  compatibilityProposalApproved: "item_compatibility_proposal.approved",
  compatibilityProposalRejected: "item_compatibility_proposal.rejected",
} as const;

export type AuditAction = (typeof auditActions)[keyof typeof auditActions];

/** The kinds of things an action is done to. */
export const auditEntities = {
  setting: "setting",
  admin: "admin_user",
  supplier: "supplier",
  supplierMember: "supplier_member",
  catalogCategory: "catalog_category",
  catalogAttribute: "catalog_attribute",
  catalogAttributeOption: "catalog_attribute_option",
  catalogBrand: "catalog_brand",
  catalogItem: "catalog_item",
  /** The translations of one entity (`entityId` — the entity's id, `after.entityType` says which). */
  catalogTranslation: "catalog_translation",
  /** One photo of an item; a reorder names the item instead (TASK-013). */
  catalogItemPhoto: "catalog_item_photo",
  vehicleOption: "vehicle_option",
  vehicleMake: "vehicle_make",
  vehicleModel: "vehicle_model",
  vehicleGeneration: "vehicle_generation",
  vehicleEngine: "vehicle_engine",
  vehicleModification: "vehicle_modification",
  vehicleImport: "vehicle_import",
  itemCompatibility: "item_compatibility",
  itemCompatibilityProposal: "item_compatibility_proposal",
} as const;

export type AuditEntityType = (typeof auditEntities)[keyof typeof auditEntities];

/** Who acted. `operator` — the server command, it has no account. */
export const auditActorRoleSchema = z.enum(["admin", "supplier", "user", "operator", "system"]);

export type AuditActorRole = z.infer<typeof auditActorRoleSchema>;

export const auditActorSchema = z.object({
  role: auditActorRoleSchema,
  /** The account that acted; `null` for the operator command and the system. */
  accountId: z.string().nullable(),
  /** That account's number, partly hidden (`+7***1234`); `null` without an account. */
  phoneMasked: z.string().nullable(),
  adminId: z.string().nullable(),
  supplierId: z.string().nullable(),
  supplierMemberId: z.string().nullable(),
});

export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  /** `<entity>.<what happened>`, e.g. `setting.changed`, `admin.granted`. */
  action: z.string(),
  actor: auditActorSchema,
  entityType: z.string(),
  entityId: z.string(),
  /** The state before and after the action; `null` when the action has none. */
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  at: z.string(),
});

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

/** How many entries one page returns at most. */
export const AUDIT_LOG_MAX_PAGE_SIZE = 100;
export const AUDIT_LOG_DEFAULT_PAGE_SIZE = 50;

/**
 * Filters and paging of `GET /admin/audit-log`, newest first. Values
 * arrive as query strings; `limit` is coerced. `cursor` is the `nextCursor`
 * of the previous page — the only way to ask for the next one, so paging
 * can't drift when entries are added while reading.
 */
export const auditLogQuerySchema = z.object({
  /** Only entries at or after this moment (ISO 8601). */
  from: z.iso.datetime().optional(),
  /** Only entries strictly before this moment (ISO 8601). */
  to: z.iso.datetime().optional(),
  action: z.string().min(1).max(100).optional(),
  entityType: z.string().min(1).max(50).optional(),
  entityId: z.string().min(1).max(200).optional(),
  actorAccountId: z.uuid().optional(),
  actorRole: auditActorRoleSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_LOG_MAX_PAGE_SIZE)
    .default(AUDIT_LOG_DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogPageSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  /** Pass as `cursor` for the next page; `null` — this was the last one. */
  nextCursor: z.string().nullable(),
});

export type AuditLogPage = z.infer<typeof auditLogPageSchema>;
