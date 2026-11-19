import { photoInvalid } from "./price-import-errors";

/**
 * The pages of a photographed price list out of a `multipart/form-data`
 * body (TASK-064.A; ARCHITECTURE 4.93): the parts named `page`, in their
 * order, as views of the body — nothing is copied.
 *
 * Read by hand rather than by the platform's `Response.formData()`, which
 * takes every part of the body in and copies it before anything can be
 * counted: a body of a hundred thousand tiny parts, or of one page larger
 * than any page may be, would cost the whole of it. Here the parts are
 * walked one by one and the walk stops at the first one past
 * `maxPages` (`too_many_pages`), at a page larger than `maxPageMb`
 * (`too_large`, with its number), and at anything that is no form
 * (`malformed`) — the same refusals and words as before.
 *
 * Parts with other names are skipped (as before), but at most
 * `OTHER_PARTS_MAX` of them; a part named `page` that is no file (no
 * `filename`) is `malformed`, as the platform's parser made it.
 */

/** Parts with other names a form may carry along (a browser adds none). */
export const OTHER_PARTS_MAX = 16;
/** The longest header section of one part. */
const HEADERS_MAX = 8 * 1024;
/** RFC 2046: a boundary is 1 to 70 characters. */
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/;

const CRLF = Buffer.from("\r\n");
const HEADERS_END = Buffer.from("\r\n\r\n");

export interface PhotoFormLimits {
  maxPages: number;
  maxPageMb: number;
}

function malformed(): never {
  throw photoInvalid(null, "malformed");
}

/** The boundary of a `multipart/form-data` content type; `null` — none or not a form. */
export function formBoundary(contentType: string): string | null {
  const [type, ...parameters] = contentType.split(";");
  if (type?.trim().toLowerCase() !== "multipart/form-data") return null;
  for (const parameter of parameters) {
    const match = /^\s*boundary\s*=\s*(?:"([^"]*)"|([^\s;]+))\s*$/i.exec(parameter);
    if (match) {
      const boundary = match[1] ?? match[2] ?? "";
      // A trailing space isn't allowed (RFC 2046 bchars).
      return BOUNDARY.test(boundary) && !boundary.endsWith(" ") ? boundary : null;
    }
  }
  return null;
}

/** The `name` and `filename` of a part's `Content-Disposition: form-data`. */
function disposition(headers: string): { name: string; file: boolean } {
  for (const line of headers.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) malformed();
    if (line.slice(0, colon).trim().toLowerCase() !== "content-disposition") continue;
    const value = line.slice(colon + 1);
    if (!/^\s*form-data\s*(;|$)/i.test(value)) malformed();
    const name = /;\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+))/i.exec(value);
    if (!name) malformed();
    return {
      name: name[1] ?? name[2] ?? "",
      file: /;\s*filename\*?\s*=/i.test(value),
    };
  }
  malformed();
}

export function photoFormPages(
  contentType: string,
  body: Buffer,
  limits: PhotoFormLimits,
): Buffer[] {
  const boundary = formBoundary(contentType);
  if (boundary === null) malformed();
  const delimiter = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  const maxPageBytes = limits.maxPageMb * 1024 * 1024;
  // The first delimiter: at the very start or after a preamble line.
  // (An empty preamble — the body starting with «\r\n--boundary» — is the
  // second case at index 0, so the case is a flag, not the index.)
  const leading = body.subarray(0, delimiter.length).equals(delimiter);
  let at = leading ? 0 : body.indexOf(next);
  if (at < 0) malformed();
  at += leading ? delimiter.length : next.length;
  const pages: Buffer[] = [];
  let others = 0;
  for (;;) {
    // After a delimiter: «--» ends the form, a line break starts a part.
    if (body[at] === 0x2d && body[at + 1] === 0x2d) return pages;
    // Transport padding (RFC 2046) before the line break.
    while (body[at] === 0x20 || body[at] === 0x09) at++;
    if (!body.subarray(at, at + 2).equals(CRLF)) malformed();
    at += 2;
    const headersEnd = body.indexOf(HEADERS_END, at);
    if (headersEnd < 0 || headersEnd - at > HEADERS_MAX) malformed();
    const part = disposition(body.subarray(at, headersEnd).toString("latin1"));
    const start = headersEnd + HEADERS_END.length;
    if (part.name === "page") {
      if (!part.file) malformed();
      if (pages.length >= limits.maxPages) {
        throw photoInvalid(null, "too_many_pages", limits.maxPages);
      }
      // Searched no further than a page may be long: a larger one is refused
      // without walking the rest of it.
      const window = body.subarray(start, start + maxPageBytes + next.length);
      const end = window.indexOf(next);
      if (end < 0) {
        if (window.length === maxPageBytes + next.length) {
          throw photoInvalid(pages.length + 1, "too_large", limits.maxPageMb);
        }
        malformed();
      }
      pages.push(body.subarray(start, start + end));
      at = start + end + next.length;
    } else {
      if (++others > OTHER_PARTS_MAX) malformed();
      const end = body.indexOf(next, start);
      if (end < 0) malformed();
      at = end + next.length;
    }
  }
}
