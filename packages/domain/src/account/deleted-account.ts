/**
 * What stands in place of the phone number of a deleted account (TASK-072,
 * D-077; ARCHITECTURE 4.96): `deleted:` and letters only. The value keeps
 * the column's uniqueness and `NOT NULL`, frees the number for a new
 * registration, and is never found by a search of digits; with no digits in
 * it, every masking of a number (`maskPhone`, `hidePhone`) turns it into
 * `***` — no screen can show a part of it as if it were a number.
 *
 * The letters are a keyed hash of the old number (the server computes it,
 * see `AccountDeletion`), written in the sixteen letters `a`…`p` instead of
 * hexadecimal digits; after the retention period it is replaced by letters
 * of nothing at all.
 */
export const DELETED_PHONE_PREFIX = "deleted:";

/** `deleted:` and the hexadecimal digest written with the letters a…p. */
export function deletedPhoneOf(hexDigest: string): string {
  if (!/^[0-9a-f]+$/i.test(hexDigest)) {
    throw new Error("A hexadecimal digest is expected");
  }
  const letters = [...hexDigest.toLowerCase()]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join("");
  return `${DELETED_PHONE_PREFIX}${letters}`;
}

/** Whether the stored «phone» is that of a deleted account. */
export function isDeletedPhone(phone: string): boolean {
  return phone.startsWith(DELETED_PHONE_PREFIX);
}
