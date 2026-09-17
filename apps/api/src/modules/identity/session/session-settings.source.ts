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
  refreshPerSession: RateLimitSettings;
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
