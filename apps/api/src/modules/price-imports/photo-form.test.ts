import { describe, expect, it } from "vitest";
import { ApiException } from "../../common/errors";
import { formBoundary, OTHER_PARTS_MAX, photoFormPages } from "./photo-form";

const BOUNDARY = "----adclubBoundary7MA4YWxk";
const TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const LIMITS = { maxPages: 3, maxPageMb: 1 };

interface Part {
  name: string;
  filename?: string;
  body: Buffer | string;
}

/** A form as a browser writes it. */
function form(parts: Part[], boundary = BOUNDARY, preamble = ""): Buffer {
  const chunks: Buffer[] = [Buffer.from(preamble)];
  for (const part of parts) {
    const file = part.filename === undefined ? "" : `; filename="${part.filename}"`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${file}\r\n` +
          `${part.filename === undefined ? "" : "Content-Type: image/jpeg\r\n"}\r\n`,
      ),
      Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const page = (body: Buffer | string, index = 1): Part => ({
  name: "page",
  filename: `page-${String(index)}.jpg`,
  body,
});

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    return (error as ApiException).options.details;
  }
  throw new Error("Not refused");
}

describe("photoFormPages", () => {
  it("gives the pages in their order, as views of the body — nothing copied", () => {
    // Bytes that look like a boundary but aren't one stay in the page.
    const first = Buffer.from(`\xff\xd8 --${BOUNDARY.slice(0, 10)} \r\n not the end`, "latin1");
    const body = form([page(first), { name: "note", body: "skipped" }, page("second", 2)]);
    const pages = photoFormPages(TYPE, body, LIMITS);
    expect(pages.map((bytes) => bytes.toString("latin1"))).toEqual([
      first.toString("latin1"),
      "second",
    ]);
    expect(pages[0]!.buffer).toBe(body.buffer);
  });

  it("reads a form with a preamble, a quoted boundary and an empty form", () => {
    const quoted = `multipart/form-data; charset=utf-8; boundary="${BOUNDARY}"`;
    expect(
      photoFormPages(quoted, form([page("a")], BOUNDARY, "preamble\r\n"), LIMITS),
    ).toHaveLength(1);
    expect(photoFormPages(TYPE, form([]), LIMITS)).toEqual([]);
  });

  it("stops at the first page past the limit", () => {
    const body = form(Array.from({ length: 50_000 }, (_, index) => page("x", index + 1)));
    expect(refusal(() => photoFormPages(TYPE, body, LIMITS))).toEqual({
      page: null,
      reason: "too_many_pages",
      limit: 3,
    });
  });

  it("refuses a page larger than a page may be, by its number, without walking the rest", () => {
    const large = Buffer.alloc(1024 * 1024 + 1, 0x41);
    expect(refusal(() => photoFormPages(TYPE, form([page("a"), page(large, 2)]), LIMITS))).toEqual({
      page: 2,
      reason: "too_large",
      limit: 1,
    });
    // Exactly the limit is a page.
    const exact = Buffer.alloc(1024 * 1024, 0x41);
    expect(photoFormPages(TYPE, form([page(exact)]), LIMITS)[0]).toHaveLength(1024 * 1024);
  });

  it("refuses what is no form: no boundary, a cut body, a page without a file, too many other parts", () => {
    const malformed = { page: null, reason: "malformed", limit: null };
    expect(refusal(() => photoFormPages("image/jpeg", form([page("a")]), LIMITS))).toEqual(
      malformed,
    );
    expect(refusal(() => photoFormPages(TYPE, Buffer.from("not a form at all"), LIMITS))).toEqual(
      malformed,
    );
    const whole = form([page("abc")]);
    expect(
      refusal(() => photoFormPages(TYPE, whole.subarray(0, whole.length - 12), LIMITS)),
    ).toEqual(malformed);
    expect(
      refusal(() => photoFormPages(TYPE, form([{ name: "page", body: "text" }]), LIMITS)),
    ).toEqual(malformed);
    const others = Array.from({ length: OTHER_PARTS_MAX + 1 }, () => ({ name: "x", body: "y" }));
    expect(refusal(() => photoFormPages(TYPE, form(others), LIMITS))).toEqual(malformed);
    const noDisposition = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\nx\r\n--${BOUNDARY}--`,
    );
    expect(refusal(() => photoFormPages(TYPE, noDisposition, LIMITS))).toEqual(malformed);
  });
});

describe("formBoundary", () => {
  it("takes the boundary of a form only", () => {
    expect(formBoundary(`Multipart/Form-Data; boundary=abc`)).toBe("abc");
    expect(formBoundary(`multipart/form-data; boundary="a b"`)).toBe("a b");
    expect(formBoundary("multipart/form-data")).toBeNull();
    expect(formBoundary("multipart/mixed; boundary=abc")).toBeNull();
    expect(formBoundary(`multipart/form-data; boundary=${"x".repeat(71)}`)).toBeNull();
  });
});
