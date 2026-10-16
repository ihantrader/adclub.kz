import type { ClubInfoResponse } from "@adclub/contracts";
import { API_PORT } from "../config/api-url";

/**
 * «Документы и поддержка» (M-PRO-06) and «Стать партнёром клуба»
 * (S-PUB-01) in the profile (TASK-077): what the club has set
 * (`GET /meta/club-info`) decides which items there are — an item without
 * its address is left out, not shown as a placeholder.
 */

/** The cabinet of the developer's machine: where `/join` is in development. */
export const DEV_SUPPLIER_WEB_PORT = 5175;

/**
 * The page «Стать партнёром клуба» opens: the club's setting; in a
 * development build without it, the cabinet running next to the API on the
 * developer's machine. `null` — no item.
 */
export function partnerFormUrl(
  info: Pick<ClubInfoResponse, "partnerFormUrl"> | null,
  dev: { apiUrl: string } | null,
): string | null {
  if (info?.partnerFormUrl) return info.partnerFormUrl;
  if (!dev) return null;
  const match = new RegExp(`^(https?://[^/]+):${API_PORT}$`).exec(dev.apiUrl);
  return match ? `${match[1]}:${DEV_SUPPLIER_WEB_PORT}/join` : null;
}

export type DocumentsRow =
  | { kind: "terms"; url: string }
  | { kind: "privacy"; url: string }
  | { kind: "consents" }
  | { kind: "contact"; phone: string | null; url: string | null };

/** The items of M-PRO-06 in their order; the version of the app is always under them. */
export function documentsRows(info: ClubInfoResponse | null, signedIn: boolean): DocumentsRow[] {
  const rows: DocumentsRow[] = [];
  if (info?.termsUrl) rows.push({ kind: "terms", url: info.termsUrl });
  if (info?.privacyUrl) rows.push({ kind: "privacy", url: info.privacyUrl });
  if (signedIn) rows.push({ kind: "consents" });
  if (info?.supportPhone || info?.supportUrl) {
    rows.push({ kind: "contact", phone: info.supportPhone, url: info.supportUrl });
  }
  return rows;
}
