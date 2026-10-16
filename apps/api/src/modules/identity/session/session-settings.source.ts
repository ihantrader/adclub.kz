import type { SessionKind } from "@adclub/contracts";
import type { RateLimitSettings } from "../../../config";

/** Session lifetimes and refresh thresholds (ARCHITECTURE 8.2, 14): the `session_*` settings. */
export interface SessionSettings {
  accessTokenTtlSeconds: number;
  /**
   * Session lifetime per kind. `mobile` and `supplier_web` slide: every
   * refresh moves the end to now + lifetime. `admin_web` never moves past
   * sign-in + lifetime.
   */
  ttlSeconds: Record<SessionKind, number>;
  /**
   * How long after a refresh the token it replaced still returns the same
   * new pair (a retried or concurrent refresh by the same client) instead
   * of counting as reuse.
   */
  refreshReuseGraceSeconds: number;
  /** Refreshes of one mobile session: the app exchanges only when its access token expires. */
  refreshPerSession: RateLimitSettings;
  /**
   * Refreshes of one cabinet or admin panel session: the access token lives
   * only in the page's memory, so every reload, new tab or link opened from
   * WhatsApp is an exchange (TASK-077, ARCHITECTURE 4.73).
   */
  refreshPerWebSession: RateLimitSettings;
  refreshPerIp: RateLimitSettings;
}

/**
 * Where session lifetimes and refresh thresholds come from. Provided by
 * the settings module (`SettingsSessionSource`, ARCHITECTURE 4.11). Read
 * on every sign-in, refresh and access check; implementations cache. The
 * token secret is not a setting: it stays in the environment.
 */
export abstract class SessionSettingsSource {
  abstract getSettings(): Promise<SessionSettings>;
}
