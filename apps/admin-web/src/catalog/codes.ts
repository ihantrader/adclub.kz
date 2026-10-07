/**
 * A suggestion for the stable code of a new category, attribute or option
 * (TASK-035): the Russian name in Latin letters, snake_case. Only a
 * suggestion — the administrator may type another, the server checks it.
 */
const LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  ә: "a",
  ғ: "g",
  қ: "k",
  ң: "n",
  ө: "o",
  ұ: "u",
  ү: "u",
  һ: "h",
  і: "i",
};

/**
 * `startsWithLetter` — category and attribute codes must start with a
 * letter; option codes may start with a digit (`5w_30`).
 */
export function suggestCode(name: string, startsWithLetter = true): string {
  const latin = [...name.toLowerCase()].map((char) => LATIN[char] ?? char).join("");
  let code = latin
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63);
  if (startsWithLetter && /^[0-9]/.test(code)) code = `x_${code}`.slice(0, 63);
  return code;
}
