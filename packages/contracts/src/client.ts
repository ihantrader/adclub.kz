import { z } from "zod";

/**
 * Every first-party client identifies itself on each request (ARCHITECTURE
 * 7.4) so the server can log the version spread and refuse versions below
 * the supported minimum.
 */
export const clientPlatformSchema = z.enum(["ios", "android", "supplier-web", "admin-web"]);

export type ClientPlatform = z.infer<typeof clientPlatformSchema>;

export const clientPlatforms = clientPlatformSchema.options;

export interface ClientInfo {
  platform: ClientPlatform;
  version: string;
}

/** Request header carrying `ClientInfo`, e.g. `mobile/1.4.2 (ios)`, `admin-web/0.1.0`. */
export const CLIENT_HEADER = "X-Client";

const MAX_HEADER_LENGTH = 64;
const MOBILE_HEADER_PATTERN = /^mobile\/(\S{1,32}) \((ios|android)\)$/;
const WEB_HEADER_PATTERN = /^(supplier-web|admin-web)\/(\S{1,32})$/;

export function formatClientHeader(client: ClientInfo): string {
  return client.platform === "ios" || client.platform === "android"
    ? `mobile/${client.version} (${client.platform})`
    : `${client.platform}/${client.version}`;
}

/**
 * Parses the `X-Client` header. Returns `null` for anything that doesn't
 * match the documented shape — callers treat that as an unknown client,
 * never as an error. The version is returned as sent; whether it's a
 * valid version number is the caller's decision (`@adclub/domain`).
 */
export function parseClientHeader(value: string | null | undefined): ClientInfo | null {
  if (!value || value.length > MAX_HEADER_LENGTH) {
    return null;
  }

  const trimmed = value.trim();
  const mobile = MOBILE_HEADER_PATTERN.exec(trimmed);
  if (mobile) {
    return { platform: mobile[2] as ClientPlatform, version: mobile[1]! };
  }

  const web = WEB_HEADER_PATTERN.exec(trimmed);
  if (web) {
    return { platform: web[1] as ClientPlatform, version: web[2]! };
  }

  return null;
}
