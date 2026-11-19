import type { AccountConsent, AccountDeletionPreview, ConsentKindValue } from "@adclub/contracts";
import type { MobileTextKey } from "@adclub/i18n";

/**
 * The rules of M-PRO-05 «Удаление аккаунта» and of the consents (TASK-072,
 * D-077), without React Native — the screens only show what these decide.
 */

/**
 * T-PRO-04: the store a subscription is cancelled in. The server names the
 * store of a subscription it knows of; without one, the store of this
 * phone — the person may have bought it on this very device.
 */
export function deletionStoreName(
  preview: Pick<AccountDeletionPreview, "subscriptionPlatform"> | null,
  os: string,
): "App Store" | "Google Play" {
  const platform = preview?.subscriptionPlatform ?? (os === "ios" ? "ios" : "android");
  return platform === "ios" ? "App Store" : "Google Play";
}

/** Why «Продолжить» does not lead on: the first refusal, in words of the screen. */
export function deletionRefusal(
  preview: Pick<AccountDeletionPreview, "blockers"> | null,
): { key: MobileTextKey; company?: string } | null {
  const blocker = preview?.blockers[0];
  if (!blocker) return null;
  return blocker.kind === "administrator"
    ? { key: "deleteAccount.administrator" }
    : { key: "deleteAccount.lastMember", company: blocker.supplierName };
}

/** The refusal the server gave to «Удалить» itself (409 `ACCOUNT_DELETION_REFUSED`). */
export function refusalOfError(details: unknown): { key: MobileTextKey; company?: string } | null {
  if (typeof details !== "object" || details === null) return null;
  const { reason, supplierName } = details as { reason?: unknown; supplierName?: unknown };
  if (reason === "administrator") return { key: "deleteAccount.administrator" };
  if (reason === "last_member") {
    return {
      key: "deleteAccount.lastMember",
      company: typeof supplierName === "string" ? supplierName : "",
    };
  }
  return null;
}

export const CONSENT_LABEL: Record<ConsentKindValue, MobileTextKey> = {
  phone_share: "consents.kind.phone_share",
  terms: "consents.kind.terms",
  vehicle_document: "consents.kind.vehicle_document",
};

/** «Мои согласия»: the latest consent of each kind, in the order of the kinds. */
export function myConsents(consents: readonly AccountConsent[]): AccountConsent[] {
  const seen = new Set<ConsentKindValue>();
  const latest: AccountConsent[] = [];
  for (const entry of [...consents].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    if (!seen.has(entry.kind)) {
      seen.add(entry.kind);
      latest.push(entry);
    }
  }
  const order: ConsentKindValue[] = ["phone_share", "terms", "vehicle_document"];
  return latest.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
