/**
 * The single access rule of the server (ARCHITECTURE 8.3). Rights come
 * from the kind of the calling session and the current state of the
 * membership or administrator record behind it — never from other roles
 * of the same account and never from request headers.
 */

export type AccessContext = "user" | "supplier" | "admin";

export type SessionKind = "mobile" | "supplier_web" | "admin_web";

/** What the server currently knows about the calling session, read on every request. */
export type AccessPrincipal =
  | { kind: "mobile" }
  | {
      kind: "supplier_web";
      /** The membership the session works for; `null` if it no longer exists. */
      membership: { status: "active" | "removed" } | null;
    }
  | {
      kind: "admin_web";
      /** The administrator record of the account; `null` if there is none. */
      admin: { status: "active" | "removed"; totpConfigured: boolean } | null;
    };

/**
 * Why a session lost its context for good. Such a session must be ended:
 * a restored membership or a re-appointed administrator signs in again.
 */
export type ContextLossReason = "membership_removed" | "admin_removed" | "totp_reset";

export type AccessDecision =
  | { allowed: true; context: AccessContext }
  /** The session has a context, but the route doesn't serve it. */
  | { allowed: false; reason: "context_not_allowed"; context: AccessContext }
  /** The session no longer has any context (membership removed etc.). */
  | { allowed: false; reason: ContextLossReason };

/** The context a session acts in right now, or why it has none any more. */
export function resolveAccessContext(
  principal: AccessPrincipal,
): { context: AccessContext } | { lost: ContextLossReason } {
  switch (principal.kind) {
    case "mobile":
      return { context: "user" };
    case "supplier_web":
      return principal.membership?.status === "active"
        ? { context: "supplier" }
        : { lost: "membership_removed" };
    case "admin_web":
      if (principal.admin?.status !== "active") {
        return { lost: "admin_removed" };
      }
      // An admin session exists only after the second factor; a reset
      // second factor takes the session's rights away too.
      return principal.admin.totpConfigured ? { context: "admin" } : { lost: "totp_reset" };
  }
}

/**
 * May `principal` use a route that serves `routeContexts`? In the MVP
 * every active employee of a company and every administrator have the
 * same rights; employee roles and permissions (BACKLOG) will narrow the
 * decision here, after the context check, without changing callers.
 */
export function decideAccess(
  routeContexts: readonly AccessContext[],
  principal: AccessPrincipal,
): AccessDecision {
  const resolved = resolveAccessContext(principal);
  if ("lost" in resolved) {
    return { allowed: false, reason: resolved.lost };
  }
  if (!routeContexts.includes(resolved.context)) {
    return { allowed: false, reason: "context_not_allowed", context: resolved.context };
  }
  return { allowed: true, context: resolved.context };
}
