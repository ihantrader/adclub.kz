/**
 * Kazakhstan mobile numbers (PRODUCT 6.1: the MVP accepts only these).
 *
 * Kazakhstan shares country code +7 with Russia; its numbers are the
 * national numbers starting with 7. Among those, 71x/72x are landline
 * area codes (7172 Astana, 727 Almaty…), while mobile operators use
 * 70x, 74x, 75x, 76x and 77x (700–708 Altel/Kcell/Beeline/Tele2, 747,
 * 771, 775–778…). So a mobile number is `+7` followed by ten digits
 * starting with `7` and then one of 0, 4, 5, 6, 7.
 */
const KZ_MOBILE_NATIONAL = /^7[04-7]\d{8}$/;

/** Separators people type or paste inside a phone number (\s covers no-break spaces). */
const SEPARATORS = /[\s()\-.]/g;

/**
 * Brings the ways people write one Kazakhstan mobile number to a single
 * E.164 form `+77XXXXXXXXX`: `+7 701 123 45 67`, `8 (701) 123-45-67`,
 * `87011234567`, `77011234567`, `7011234567`. Returns `null` for anything
 * else — letters, another country, a landline, the wrong length.
 */
export function normalizeKzMobilePhone(input: string): string | null {
  const compact = input.replace(SEPARATORS, "");
  let national: string;
  if (/^\+7\d{10}$/.test(compact)) {
    national = compact.slice(2);
  } else if (/^[78]\d{10}$/.test(compact)) {
    national = compact.slice(1);
  } else if (/^\d{10}$/.test(compact)) {
    national = compact;
  } else {
    return null;
  }
  return KZ_MOBILE_NATIONAL.test(national) ? `+7${national}` : null;
}

/**
 * Log-safe form of a phone number (ARCHITECTURE 15.3): only the last four
 * digits survive, e.g. `+7***4567`; the number can't be restored from it.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) {
    return "***";
  }
  return `+${digits.slice(0, 1)}***${digits.slice(-4)}`;
}
