import { normalizeArticle } from "../article/normalize-article";
import { phoneSearchDigits } from "../phone/phone-search";

/**
 * How the one search line of the admin panel is read (TASK-036.B; SCREENS
 * 7.0 A-SEARCH). A line may mean several things at once — «1028» is the
 * number of an order and a part of a phone number — so every reading that
 * fits is kept and the server looks in each place:
 *
 * - `phoneDigits` — a phone number, whole or a part (`phoneSearchDigits`);
 * - `orderNumber` — «№ 4821», «#4821» or a bare number of up to nine digits;
 * - `bin` — exactly twelve digits (a БИН, with or without spaces);
 * - `article` — a catalog article in any spelling: letters and digits
 *   together, at least three of them after normalization (`normalizeArticle`);
 * - `text` — anything with letters: names of suppliers, items and users.
 */
export interface AdminQueryReading {
  phoneDigits: string[] | null;
  orderNumber: number | null;
  bin: string | null;
  article: string | null;
  text: string | null;
}

const ORDER_NUMBER = /^(?:№|#|n[o°]?\.?)?\s*(\d{1,9})$/i;
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\d/;

export function readAdminQuery(input: string): AdminQueryReading {
  const text = input.trim().replace(/\s+/g, " ");
  const number = ORDER_NUMBER.exec(text);
  const digitsOnly = text.replace(/\s/g, "");
  const bin = /^\d{12}$/.test(digitsOnly) ? digitsOnly : null;
  const normalized = normalizeArticle(text);
  const article =
    HAS_DIGIT.test(normalized) && HAS_LETTER.test(normalized) && normalized.length >= 3
      ? normalized
      : // A bare number is an article too when it is long enough (`4050068800`).
        /^\d{6,}$/.test(normalized) && bin === null && !text.startsWith("+")
        ? normalized
        : null;
  return {
    phoneDigits: phoneSearchDigits(text),
    orderNumber: number ? Number(number[1]) : null,
    bin,
    article,
    text: HAS_LETTER.test(text) && text.length >= 2 ? text : null,
  };
}
