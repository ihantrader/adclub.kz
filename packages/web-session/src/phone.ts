/**
 * A Kazakhstan number as people read it: `+7 705 555 01 01`. Anything that
 * is not `+7` and ten digits is shown as it came.
 */
export function formatPhone(phone: string): string {
  const match = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return match ? `+7 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone;
}

/**
 * The phone field as the person types (S-AUTH-01, S-TEAM-01): keeps `+7 ` in
 * front and groups the digits; up to ten digits after the country code.
 */
export function typePhone(input: string): string {
  let digits = input.replace(/\D/g, "");
  // The country code: «+7» in front, a trunk «8», or eleven digits from «7».
  // National mobile numbers start with 7 themselves (705…), so a bare
  // leading 7 of a shorter number stays.
  if (
    input.trimStart().startsWith("+7") ||
    digits.startsWith("8") ||
    (digits.length === 11 && digits.startsWith("7"))
  ) {
    digits = digits.slice(1);
  }
  digits = digits.slice(0, 10);
  const groups = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 8), digits.slice(8, 10)];
  return `+7 ${groups.filter(Boolean).join(" ")}`.trimEnd();
}
