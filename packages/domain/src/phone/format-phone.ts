import { normalizeKzMobilePhone } from "./kz-mobile-phone";

/**
 * One way of writing a Kazakhstan phone number for people (DESIGN 4 «тон»,
 * TASK-078 M4): «+7 7XX XXX XX XX» — the country code, then the operator
 * code and the number in the groups people say them in. Every place that
 * shows a number — the code screen, the profile, the pickup point of an
 * order, the contact of the club — and the field a number is typed into
 * use this module, so a number never appears as a bare `+77010000380`.
 */

const COUNTRY = "+7";

/** `7011234567` → `701 123 45 67`, as far as the digits go. */
function groupNational(national: string): string {
  const parts = [
    national.slice(0, 3),
    national.slice(3, 6),
    national.slice(6, 8),
    national.slice(8, 10),
  ];
  return parts.filter((part) => part.length > 0).join(" ");
}

/**
 * A number to show. A Kazakhstan number in any writing («87011234567»,
 * «+7 (701) 123-45-67») is written out as «+7 701 123 45 67»; anything else
 * — a number of another country, a landline, an incomplete number — is
 * shown as it came, only trimmed: this module never guesses at a number it
 * does not recognise.
 */
export function formatKzPhone(phone: string): string {
  const normalized = normalizeKzMobilePhone(phone);
  if (normalized) return `${COUNTRY} ${groupNational(normalized.slice(2))}`;
  return phone.trim();
}

/** What an empty phone field shows: the country code, ready for the rest. */
export const KZ_PHONE_PLACEHOLDER = "+7 7__ ___ __ __";

/** The ten national digits a person typed into a `+7` field, from any writing. */
export function kzPhoneDigits(raw: string): string {
  const compact = raw.replace(/\D/g, "");
  let national: string;
  if (/^\+\s*7/.test(raw.trim())) {
    national = compact.slice(1);
  } else if (compact.length >= 11 && (compact.startsWith("7") || compact.startsWith("8"))) {
    // «87011234567» / «77011234567» pasted whole: the first digit is the trunk or the country.
    national = compact.slice(1);
  } else {
    national = compact;
  }
  return national.slice(0, 10);
}

/**
 * The mask of the phone field (M-AUTH-01 «+7 7__ ___ __ __»): what the field
 * shows after a change. The country code stays; the digits typed or pasted
 * are grouped as they come, never more than ten. Deleting the space between
 * groups deletes the digit before it (`previous` — what the field showed
 * before the change), so the caret never gets stuck on a separator.
 */
export function maskKzPhoneInput(next: string, previous?: string): string {
  let national = kzPhoneDigits(next);
  if (
    previous !== undefined &&
    next.length < previous.length &&
    national === kzPhoneDigits(previous) &&
    national.length > 0
  ) {
    national = national.slice(0, -1);
  }
  return national.length === 0 ? `${COUNTRY} ` : `${COUNTRY} ${groupNational(national)}`;
}
