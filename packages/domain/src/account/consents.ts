/**
 * The consents an account gives and their versions (TASK-072, D-077;
 * ARCHITECTURE 4.96, 8.5 point 3). Every consent given is a row of the
 * account's journal of consents — what, which version of the text, when;
 * the current state is read from the journal, never kept beside it.
 *
 * The current version of each text is a setting: when the lawyer's text
 * changes, the architect raises the version and every account that gave an
 * older one is asked again («Мы обновили условия»). Versions are labels,
 * not numbers — «newer» is «not the one in the setting».
 */
export const consentKinds = [
  // T-AUTH-05: the number goes to a supplier once it accepts an order.
  "phone_share",
  // The terms of use and the privacy policy (M-AUTH-03, M-PRO-06).
  "terms",
  // D-064, T-GAR-02: the VIN and the plate number are kept in the garage.
  "vehicle_document",
] as const;

export type ConsentKind = (typeof consentKinds)[number];

/** One row of the journal of consents. */
export interface GivenConsent {
  kind: ConsentKind;
  version: string;
  at: Date | string;
}

export type ConsentVersions = Record<ConsentKind, string>;

function time(value: Date | string): number {
  return typeof value === "string" ? Date.parse(value) : value.getTime();
}

/** The last consent of each kind (the journal may hold several of one kind). */
export function latestConsents(
  given: readonly GivenConsent[],
): Partial<Record<ConsentKind, GivenConsent>> {
  const latest: Partial<Record<ConsentKind, GivenConsent>> = {};
  for (const entry of given) {
    const current = latest[entry.kind];
    if (!current || time(entry.at) >= time(current.at)) {
      latest[entry.kind] = entry;
    }
  }
  return latest;
}

/**
 * The consents an account must give again before it orders: one never given
 * or given for another version than the current one. The phone share and
 * the terms concern every member; the vehicle document only an account that
 * keeps a VIN or a plate number in its garage (D-064) — someone who never
 * saved one has nothing to agree to.
 */
export function outdatedConsents(
  given: readonly GivenConsent[],
  current: ConsentVersions,
  facts: { storesVehicleDocument: boolean },
): ConsentKind[] {
  const latest = latestConsents(given);
  return consentKinds.filter((kind) => {
    if (kind === "vehicle_document" && !facts.storesVehicleDocument) {
      return false;
    }
    return latest[kind]?.version !== current[kind];
  });
}
