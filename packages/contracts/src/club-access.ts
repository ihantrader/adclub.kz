import { z } from "zod";

/**
 * Club access of a user (TASK-020, D-059; ARCHITECTURE 4.29): whether an
 * account sees what only club members see — the names of suppliers and
 * the district or address of their pickup points (PRODUCT 9, D-030).
 *
 * One server function decides it for every rule of visibility. Until the
 * subscriptions of the stores arrive (EPIC-14, TASK-040) its only source
 * is a grant given by hand — by an administrator or the operator command,
 * for the internal alpha, test users and the club's staff — with an end
 * date and a reason; everything lands in the journal of actions. TASK-040
 * adds subscriptions to the same function without changing its callers.
 */

export const CLUB_ACCESS_REASON_MAX_LENGTH = 500;
/** How far ahead a manual grant may end. */
export const CLUB_ACCESS_MAX_DAYS = 2 * 366;
export const CLUB_ACCESS_PAGE_MAX_SIZE = 100;
export const CLUB_ACCESS_PAGE_DEFAULT_SIZE = 50;

function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });
}

/** Where access comes from: `manual` — a grant by hand (stores' subscriptions come with TASK-040). */
export const clubAccessSourceSchema = z.enum(["manual"]);

export type ClubAccessSource = z.infer<typeof clubAccessSourceSchema>;

/** The access of an account now. */
export const clubAccessStateSchema = z.object({
  granted: z.boolean(),
  /** What gives it; `null` without access. */
  source: clubAccessSourceSchema.nullable(),
  /** When it ends; `null` without access. */
  validUntil: z.iso.datetime().nullable(),
});

export type ClubAccessState = z.infer<typeof clubAccessStateSchema>;

/** Who gave or ended a grant: an administrator, or the server operator command. */
export const clubAccessActorSchema = z.object({
  role: z.enum(["admin", "operator"]),
  adminId: z.uuid().nullable(),
});

export type ClubAccessActor = z.infer<typeof clubAccessActorSchema>;

/**
 * `active` — in force now; `expired` — its end date passed; `revoked` —
 * ended early by hand; `replaced` — a newer grant of the account took its
 * place.
 */
export const clubAccessGrantStatusSchema = z.enum(["active", "expired", "revoked", "replaced"]);

export type ClubAccessGrantStatus = z.infer<typeof clubAccessGrantStatusSchema>;

export const clubAccessGrantSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  /** The phone number masked (`+7 701 ••• •• 67`): the full number never leaves the server here. */
  phoneMasked: z.string(),
  source: clubAccessSourceSchema,
  status: clubAccessGrantStatusSchema,
  validUntil: z.iso.datetime(),
  reason: z.string(),
  grantedBy: clubAccessActorSchema,
  grantedAt: z.iso.datetime(),
  revokedBy: clubAccessActorSchema.nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokeReason: z.string().nullable(),
});

export type ClubAccessGrant = z.infer<typeof clubAccessGrantSchema>;

/**
 * `POST /admin/club-access/grants` — give an account club access until
 * `validUntil` (in the future, at most `CLUB_ACCESS_MAX_DAYS` ahead). The
 * account is the phone number's (created if the number never signed in:
 * the person gets access when they do). A current grant of the account is
 * replaced by the new one.
 */
export const grantClubAccessBodySchema = z.object({
  phone: z.string().trim().min(1).max(32),
  validUntil: z.iso.datetime({ offset: true }),
  reason: plainText(CLUB_ACCESS_REASON_MAX_LENGTH),
});

export type GrantClubAccessBody = z.infer<typeof grantClubAccessBodySchema>;

/** `POST /admin/club-access/revoke` — end the current grant of the phone number's account now. */
export const revokeClubAccessBodySchema = z.object({
  phone: z.string().trim().min(1).max(32),
  reason: plainText(CLUB_ACCESS_REASON_MAX_LENGTH),
});

export type RevokeClubAccessBody = z.infer<typeof revokeClubAccessBodySchema>;

export const clubAccessGrantResponseSchema = z.object({
  grant: clubAccessGrantSchema,
  /** The account's access after the change. */
  access: clubAccessStateSchema,
});

export type ClubAccessGrantResponse = z.infer<typeof clubAccessGrantResponseSchema>;

/**
 * `GET /admin/club-access/grants` — grants, newest first: those in force
 * now (`status=active`, the default) or every one (`status=all`), of one
 * account (`accountId`) or of everyone; pages by `cursor` = `nextCursor`.
 */
export const clubAccessGrantQuerySchema = z.object({
  status: z.enum(["active", "all"]).optional(),
  accountId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(CLUB_ACCESS_PAGE_MAX_SIZE).optional(),
  cursor: z.string().min(1).max(300).optional(),
});

export type ClubAccessGrantQuery = z.infer<typeof clubAccessGrantQuerySchema>;

export const clubAccessGrantPageSchema = z.object({
  grants: z.array(clubAccessGrantSchema),
  nextCursor: z.string().nullable(),
});

export type ClubAccessGrantPage = z.infer<typeof clubAccessGrantPageSchema>;
