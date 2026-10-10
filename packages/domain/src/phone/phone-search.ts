/**
 * A phone number typed into a search of the admin panel (TASK-036.B;
 * SCREENS A-ORD-01, A-USR-01, A-SEARCH): whole or a part of it, in any
 * spelling — `+7 701 123`, `8 (701) 12`, `4567`. The server looks for the
 * digits inside the stored number (`+77XXXXXXXXX`) and answers with the
 * number partly hidden all the same.
 *
 * Returns the digit strings to look for — the digits as typed and, for a
 * number written with the old trunk prefix `8`, the same with `7` — or
 * `null` when the text is not a phone at all (letters, or fewer than
 * `PHONE_SEARCH_MIN_DIGITS` digits: «12» would find half the club).
 */
export const PHONE_SEARCH_MIN_DIGITS = 3;

/** `\s` takes the no-break space a pasted number may carry. */
const PHONE_TEXT = /^[\s()+\-.\d]+$/;

export function phoneSearchDigits(input: string): string[] | null {
  const text = input.trim();
  if (!PHONE_TEXT.test(text)) {
    return null;
  }
  const digits = text.replace(/\D/g, "");
  if (digits.length < PHONE_SEARCH_MIN_DIGITS || digits.length > 11) {
    return null;
  }
  const variants = new Set([digits]);
  // `8 701 …` is how many still write `+7 701 …`; a whole number of eleven
  // digits starting with 8 is never anything else.
  if (digits.startsWith("8") && (digits.length === 11 || /^8\s*\(?7/.test(text))) {
    variants.add(`7${digits.slice(1)}`);
  }
  return [...variants];
}
