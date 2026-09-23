/**
 * The warranty text of an offer must not name how to reach the supplier
 * (TASK-020.A; ARCHITECTURE 4.30; D-005, D-026). The text is free: a user
 * with club access sees it on the card of an item, where the supplier's
 * name and point are shown but its phone and hours are not until an
 * order is accepted. A phone, a link or an e-mail in the warranty would
 * hand them out early and take the deal past the platform. The server
 * checks every saved text by this one function; the rule for the
 * supplier: «название и контакты компании в гарантии указывать нельзя —
 * пользователь увидит их после принятия заявки».
 *
 * What is caught — the obvious signs:
 * - `phone`: a run of digits written as a phone number usually is — at
 *   least 7 digits, spaces, dashes, dots and brackets between them, a `+`
 *   in front: «+7 705 555 01 01», «8 (705) 555-01-01», «87055550101»,
 *   «272-12-34». Not a phone: a number grouped by thousands («100 000 км»,
 *   «1 000 000» — a mileage or a sum), a date («до 31.12.2027»), a range
 *   of years («2024-2026»);
 * - `link`: an address with a scheme or `www.`, a domain name
 *   («automarket.kz», «t.me/automarket», «сайт.рф») and a handle
 *   («@automarket» — Instagram, Telegram);
 * - `email`: `name@domain.tld`.
 *
 * What isn't: a number spelled in words or with letters for digits, a
 * name of a messenger without a handle, the company's name itself (the
 * text is only shown to viewers who see the name anyway). A moderator or
 * a model may look further one day — a task of its own.
 */

export type WarrantyContactKind = "phone" | "link" | "email";

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;

const LINK_PATTERNS: readonly RegExp[] = [
  // A scheme or www.
  /\b(?:https?|ftp):\/\//i,
  /(?:^|[^\p{L}\p{N}])www\./iu,
  // A domain name: labels of letters, digits and dashes, a dot, a top-level domain of letters.
  /(?:^|[^\p{L}\p{N}@.])[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)*\.(?:[a-z]{2,24}|рф|қаз|бел|укр|срб|мкд|онлайн|сайт|рус)(?![\p{L}\p{N}])/iu,
  // A handle: @ with at least three characters, not part of an e-mail.
  /(?:^|[^\p{L}\p{N}._%+-])@[\p{L}\p{N}_.]{3,}/u,
];

/** Runs of digits with the separators of a phone number. */
const DIGIT_RUN = /\+?\(?\d[\d\s().-]*\d/g;

/** Long runs of digits that aren't phones. */
const NOT_PHONES: readonly RegExp[] = [
  // Grouped by thousands: «100 000», «1 000 000», «1.000.000».
  /^\d{1,3}([ .])\d{3}(?:\1\d{3})*$/,
  // A date: «31.12.2027», «31/12/27».
  /^\d{1,2}([./-])\d{1,2}\1\d{2,4}$/,
  // A date: «2027-12-31».
  /^\d{4}([./-])\d{1,2}\1\d{1,2}$/,
  // A range of years: «2024-2026».
  /^(?:19|20)\d{2} ?- ?(?:19|20)\d{2}$/,
];

const PHONE_MIN_DIGITS = 7;

function hasPhone(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    const run = match[0].trim().replace(/\s+/g, " ");
    if (run.replace(/\D/g, "").length < PHONE_MIN_DIGITS) {
      continue;
    }
    if (!run.startsWith("+") && NOT_PHONES.some((pattern) => pattern.test(run))) {
      continue;
    }
    return true;
  }
  return false;
}

/** The kinds of contacts found in a warranty text, in a fixed order; empty — none. */
export function warrantyTextContacts(text: string): WarrantyContactKind[] {
  // Look-alikes count as what they look like: full-width digits (NFKC),
  // special spaces, dashes and minus signs.
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
  const found: WarrantyContactKind[] = [];
  const withoutEmails = normalized.replace(new RegExp(EMAIL.source, "gu"), " ");
  if (hasPhone(withoutEmails)) {
    found.push("phone");
  }
  if (LINK_PATTERNS.some((pattern) => pattern.test(withoutEmails))) {
    found.push("link");
  }
  if (EMAIL.test(normalized)) {
    found.push("email");
  }
  return found;
}
