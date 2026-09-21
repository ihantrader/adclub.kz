import { z } from "zod";
import { supplierCardSchema } from "./suppliers";

/**
 * Where a protected route can be used (ARCHITECTURE 8.3). Rights come
 * only from the kind of the calling session and the current server data,
 * never from other roles of the account or from request headers:
 * - `user`: a mobile app session;
 * - `supplier`: a supplier cabinet session whose employee is an active
 *   member of the session's company;
 * - `admin`: an admin panel session (opened only after the second factor)
 *   of an active administrator.
 * New contexts are only ever added.
 */
export const accessContextSchema = z.enum(["user", "supplier", "admin"]);

export type AccessContext = z.infer<typeof accessContextSchema>;

/** A company as its employees see it. */
export const supplierSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  city: z.string(),
});

export type SupplierSummary = z.infer<typeof supplierSummarySchema>;

/**
 * What the current session may act as (`GET /auth/me`):
 * - `user` — the mobile app;
 * - `supplier` — the company and the employee the cabinet session works for;
 * - `admin` — the administrator the admin panel session belongs to.
 */
export const sessionAccessSchema = z.discriminatedUnion("context", [
  z.object({ context: z.literal("user") }),
  z.object({
    context: z.literal("supplier"),
    supplier: supplierSummarySchema,
    member: z.object({ id: z.uuid(), displayName: z.string() }),
  }),
  z.object({
    context: z.literal("admin"),
    admin: z.object({ id: z.uuid() }),
  }),
]);

export type SessionAccess = z.infer<typeof sessionAccessSchema>;

/** `POST /auth/supplier-context`: switch the cabinet session to another company. */
export const switchSupplierBodySchema = z.object({
  supplierId: z.uuid(),
});

export type SwitchSupplierBody = z.infer<typeof switchSupplierBodySchema>;

/** The companies the signed-in employee is an active member of. */
export const supplierMembershipListResponseSchema = z.object({
  suppliers: z.array(supplierSummarySchema.extend({ current: z.boolean() })),
});

export type SupplierMembershipListResponse = z.infer<typeof supplierMembershipListResponseSchema>;

/** `GET /supplier/company`, `GET /supplier/companies/{supplierId}`. */
export const supplierCompanyResponseSchema = z.object({
  supplier: supplierSummarySchema.extend({
    /**
     * `active`, `paused` or `blocked` (TASK-016; `company.state`). Pause
     * and blocking don't close the cabinet (SCREENS 6.0). New values may
     * appear.
     */
    status: z.string(),
  }),
  /** The company's card (TASK-016): profile, pickup point, schedule, states. */
  company: supplierCardSchema,
});

export type SupplierCompanyResponse = z.infer<typeof supplierCompanyResponseSchema>;

/** Path parameters of `GET /supplier/companies/{supplierId}`. */
export const supplierIdPathSchema = z.object({
  supplierId: z.uuid(),
});

export type SupplierIdPath = z.infer<typeof supplierIdPathSchema>;

/** One administrator as other administrators see them. */
export const administratorSummarySchema = z.object({
  id: z.uuid(),
  /** Partly hidden (`+7***1234`), as everywhere in the admin panel. */
  phoneMasked: z.string(),
  totpConfigured: z.boolean(),
  /** The administrator making the request. */
  current: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type AdministratorSummary = z.infer<typeof administratorSummarySchema>;

/** `GET /admin/administrators`: active administrators. */
export const administratorListResponseSchema = z.object({
  administrators: z.array(administratorSummarySchema),
});

export type AdministratorListResponse = z.infer<typeof administratorListResponseSchema>;

/** Path parameters of `POST /admin/administrators/{adminId}/totp-reset`. */
export const adminIdPathSchema = z.object({
  adminId: z.uuid(),
});

export type AdminIdPath = z.infer<typeof adminIdPathSchema>;

/** Result of resetting another administrator's second factor. */
export const totpResetResponseSchema = z.object({
  /** Admin panel sessions of that administrator ended by the reset. */
  sessionsEnded: z.number().int(),
});

export type TotpResetResponse = z.infer<typeof totpResetResponseSchema>;

const totpCodeSchema = z.string().regex(/^\d{6}$/, "Must be 6 digits");

/**
 * `POST /admin/totp/backup-codes`: a new set of backup codes; the current
 * code from the authenticator app confirms it is really the administrator.
 */
export const regenerateBackupCodesBodySchema = z.object({
  totpCode: totpCodeSchema,
});

export type RegenerateBackupCodesBody = z.infer<typeof regenerateBackupCodesBodySchema>;

/** The new set (shown once); every earlier backup code stops working. */
export const backupCodesResponseSchema = z.object({
  /** Shown once: the server keeps only a form they can't be recovered from. */
  backupCodes: z.array(z.string()),
});

export type BackupCodesResponse = z.infer<typeof backupCodesResponseSchema>;
