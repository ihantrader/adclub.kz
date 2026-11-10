import type { CatalogSearchItem, PartPhotoResponse } from "@adclub/contracts";
import { tidyQuery } from "./recent-searches";

/**
 * A part by a photo of its article in the app (TASK-058, SCREENS M-CAT-06) —
 * the rules as plain functions, tested without React Native.
 *
 * The server reads the article and finds it by the search of
 * `GET /catalog/search`; the app puts the article into the search line,
 * marked «распознан» until the person edits it (SCREENS 9.3), and runs the
 * very same search — the results are those of a typed article. The other
 * articles of the label are chips «Или: …»; the analogs the server found
 * stand under the results while the article is the recognised one.
 */

/** What the search screen gets from a photo (a route parameter: plain data). */
export interface PartPhotoFound {
  /** As printed, e.g. «04465-0K090» — the text of the search line. */
  article: string;
  /** The other articles of the label, likeliest first. */
  candidates: string[];
  /** Found by the search of their own articles. */
  analogs: CatalogSearchItem[];
  /** How many items the article itself found: 0 — «Артикул не найден в каталоге». */
  total: number;
}

export type PartPhotoOutcome = { kind: "found"; found: PartPhotoFound } | { kind: "not_found" };

/** The answer as the screen takes it: an article to search, or «Не нашли артикул на фото». */
export function partPhotoOutcome(answer: PartPhotoResponse): PartPhotoOutcome {
  if (answer.kind !== "article_found" || !answer.article) return { kind: "not_found" };
  return {
    kind: "found",
    found: {
      article: answer.article.text,
      candidates: answer.candidates.map((candidate) => candidate.text),
      analogs: answer.analogs,
      total: answer.total,
    },
  };
}

/** Whether the search line still holds the recognised article (the mark «распознан»). */
export function stillRecognizedArticle(typed: string, recognized: string | null): boolean {
  return recognized !== null && tidyQuery(typed) === tidyQuery(recognized);
}
