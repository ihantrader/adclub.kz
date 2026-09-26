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
  /**
   * A company was created: by the development operator command, or (since
   * TASK-016) by an administrator — from a request or by hand. `after`:
   * name, city, type, whether from a request.
   */
  supplierCreated: "supplier.created",
  /**
   * An employee was added to a company: by the development operator
   * command, an administrator or (since TASK-017) a colleague in the
   * cabinet (actor `supplier`).
   */
  supplierMemberAdded: "supplier_member.added",
  /** An employee was removed; their cabinet sessions of that company ended with it. */
  supplierMemberRemoved: "supplier_member.removed",
  /** An administrator brought a removed employee back (`reason` — why). TASK-017. */
  supplierMemberRestored: "supplier_member.restored",
  /**
   * The name, the notification switch or language of an employee changed
   * (by themselves or a colleague). `before`/`after`: the changed fields.
   */
  supplierMemberChanged: "supplier_member.changed",
  /** An administrator appointed the contact person of a company (`before` — the previous one). */
  supplierContactPersonChanged: "supplier_member.contact_person_changed",
  /** An administrator ended cabinet sessions of employees; `after.sessionIds`. */
  supplierMemberSessionsEnded: "supplier_member.sessions_ended",
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
  /**
   * Cities (TASK-016). `created`: the city; `changed`: names or time zone;
   * `status_changed`: archived or restored; `reordered`: the entity is
   * `cities`, `before`/`after` — the ids in order.
   */
  cityCreated: "city.created",
  cityChanged: "city.changed",
  cityStatusChanged: "city.status_changed",
  citiesReordered: "city.reordered",
  /**
   * Connection requests (TASK-016). `created`: from the public form (actor
   * `system`) or by hand; `after` never holds the phone number or the БИН
   * (the request row does). `changed`: corrected data; `status_changed`:
   * a move along the funnel with the reason (also `onboarded` when the
   * supplier was created from it); `note_added`.
   */
  supplierLeadCreated: "supplier_lead.created",
  supplierLeadChanged: "supplier_lead.changed",
  supplierLeadStatusChanged: "supplier_lead.status_changed",
  supplierLeadNoteAdded: "supplier_lead.note_added",
  /** The profile of a supplier: `before`/`after` — the changed fields. */
  supplierChanged: "supplier.changed",
  /** Hours and days off, by an administrator or the supplier itself (actor `supplier`). */
  supplierScheduleChanged: "supplier.schedule_changed",
  /** Verified partner set (with the contract date) or lifted (with the reason). */
  supplierVerificationChanged: "supplier.verification_changed",
  /** Paused (reason `billing`/`admin`) or the pause lifted; `reason` — the note. */
  supplierPauseChanged: "supplier.pause_changed",
  /** Blocked or unblocked; `reason` — why. */
  supplierBlockChanged: "supplier.block_changed",
  /** An invitation to an employee was put on the queue (the first one, or again). */
  supplierInvitationRequested: "supplier_invitation.requested",
  /**
   * Offers of a supplier (TASK-018), by an employee (actor `supplier`).
   * `created`: the offer; `changed`: `before`/`after` — the changed fields
   * and the new version; `withdrawn`: taken off sale (`after.reason`);
   * `returned`: back on sale.
   */
  offerCreated: "offer.created",
  offerChanged: "offer.changed",
  offerWithdrawn: "offer.withdrawn",
  offerReturned: "offer.returned",
  /**
   * Club access given by hand (TASK-020, D-059), by an administrator or the
   * operator command: `granted` — with `after.validUntil` (a grant that
   * replaced a current one names it in `before`); `revoked` — the grant
   * ended early. `reason` — why.
   */
  clubAccessGranted: "club_access.granted",
  clubAccessRevoked: "club_access.revoked",
  /**
   * Orders (TASK-021): the supplier accepted an order and the customer's
   * phone number opened to it (actor `supplier` — the employee). The
   * order's own journal (`order_event`) holds every move; this entry
   * marks the disclosure of personal data (ARCHITECTURE 8.4). `after`
   * has the order's number, never the phone.
   */
  orderPhoneRevealed: "order.phone_revealed",
  /**
   * TASK-022 (D-043): an administrator closed a disputed order without a
   * code. `reason` — the words they had to give, `after` — the order's
   * number and status.
   */
  orderClosedByAdmin: "order.closed_by_admin",
  /**
   * A discipline mark of a user was lifted by hand (A-ORD-02); `reason` —
   * why. The two automatic liftings (a late close, an administrator's
   * close) live in the mark itself and in the order's journal.
   */
  disciplineRevoked: "user_discipline_event.revoked",
  /**
   * TASK-022: too many lookups of an employee found nothing or another
   * company's order, and the company was cut off from looking codes up for
   * a while. Written once per window, `after` — the limit, the employee and
   * how many failures; never a code.
   */
  orderLookupBlocked: "order.lookup_blocked",
  /**
   * TASK-025 (A-ORD-02, A-ORD-03; PRODUCT 10.4): an administrator extended
   * the answer deadline or the pickup reserve of an order. `reason` — why,
   * `before`/`after` — which deadline and its two values, the order's
   * number. The order's own journal has the same as `deadline_extended`.
   */
  orderDeadlineExtended: "order.deadline_extended",
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
  city: "city",
  supplierLead: "supplier_lead",
  supplierInvitation: "supplier_invitation",
  offer: "offer",
  /** A manual grant of club access (TASK-020). */
  clubAccessGrant: "club_access_grant",
  /** An order of a user (TASK-021). */
  order: "order",
  /** A discipline mark of a user (TASK-022). */
  disciplineEvent: "user_discipline_event",
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
