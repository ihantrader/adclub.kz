import { describe, expect, it } from "vitest";
import {
  complaintReasons,
  complaintReasonsFor,
  complaintTransition,
  complaintUserStatus,
  initialReviewStatus,
  reviewActions,
  reviewAuthorActions,
  reviewAuthorName,
  reviewStatuses,
  reviewText,
  reviewTransition,
  reviewUserStatus,
  type ReviewAction,
  type ReviewStatus,
} from "./review-machine";

/** The whole table: every status × every action, what is expected. */
const EXPECTED: Record<ReviewStatus, Partial<Record<ReviewAction, ReviewStatus>>> = {
  checking: { pass_check: "published", hold: "held" },
  published: { hide: "hidden" },
  held: { publish: "published", reject_text: "text_rejected" },
  text_rejected: { edit_text: "checking", publish_score_only: "published" },
  hidden: { restore: "published" },
};

describe("the review machine (TASK-049)", () => {
  it.each(
    reviewStatuses.flatMap((status) => reviewActions.map((action) => [status, action] as const)),
  )("%s + %s", (status, action) => {
    expect(reviewTransition(status, action)).toBe(EXPECTED[status][action] ?? null);
  });

  it("lets the text be corrected once", () => {
    expect(reviewTransition("text_rejected", "edit_text", { edited: false })).toBe("checking");
    expect(reviewTransition("text_rejected", "edit_text", { edited: true })).toBeNull();
    // A corrected text refused again: only the score alone is left.
    expect(reviewAuthorActions("text_rejected", { edited: true })).toEqual({
      canEditText: false,
      canPublishScoreOnly: true,
    });
    expect(reviewAuthorActions("text_rejected", { edited: false })).toEqual({
      canEditText: true,
      canPublishScoreOnly: true,
    });
    expect(reviewAuthorActions("published", { edited: false })).toEqual({
      canEditText: false,
      canPublishScoreOnly: false,
    });
  });

  it("publishes a score alone at once and checks a text", () => {
    expect(initialReviewStatus(null)).toBe("published");
    expect(initialReviewStatus("Хорошо")).toBe("checking");
    expect(reviewText("   ")).toBeNull();
    expect(reviewText("")).toBeNull();
    expect(reviewText(undefined)).toBeNull();
    expect(reviewText("  Всё хорошо \n")).toBe("Всё хорошо");
  });

  it("shows the author a hold as «на проверке» and a hide as «опубликован»", () => {
    expect(reviewUserStatus("checking")).toBe("checking");
    expect(reviewUserStatus("held")).toBe("checking");
    expect(reviewUserStatus("published")).toBe("published");
    expect(reviewUserStatus("hidden")).toBe("published");
    expect(reviewUserStatus("text_rejected")).toBe("text_rejected");
  });

  it("names the author by the first name and an initial", () => {
    expect(reviewAuthorName("Айгерим Касымова")).toBe("Айгерим К.");
    expect(reviewAuthorName("  әлия   нұрғалиқызы ")).toBe("әлия Н.");
    expect(reviewAuthorName("Марат")).toBe("Марат");
    expect(reviewAuthorName("Ержан Сейткали Болатулы")).toBe("Ержан С.");
    expect(reviewAuthorName(null)).toBeNull();
    expect(reviewAuthorName("   ")).toBeNull();
  });
});

describe("complaints (TASK-049)", () => {
  it("are taken and resolved", () => {
    expect(complaintTransition("new", "take")).toBe("in_progress");
    expect(complaintTransition("in_progress", "take")).toBeNull();
    expect(complaintTransition("resolved", "take")).toBeNull();
    expect(complaintTransition("new", "resolve")).toBe("resolved");
    expect(complaintTransition("in_progress", "resolve")).toBe("resolved");
    expect(complaintTransition("resolved", "resolve")).toBeNull();
    expect(complaintUserStatus("new")).toBe("in_review");
    expect(complaintUserStatus("in_progress")).toBe("in_review");
    expect(complaintUserStatus("resolved")).toBe("resolved");
  });

  it("are made about an accepted or a finished order, «не получил» only a given out one", () => {
    expect(complaintReasonsFor("completed")).toEqual([...complaintReasons]);
    for (const status of ["accepted", "ready", "cancelled_by_user", "no_show", "reserve_expired"]) {
      expect(complaintReasonsFor(status)).toEqual(
        complaintReasons.filter((reason) => reason !== "not_received"),
      );
    }
    for (const status of ["created", "term_proposed"]) {
      expect(complaintReasonsFor(status)).toEqual([]);
    }
  });
});
