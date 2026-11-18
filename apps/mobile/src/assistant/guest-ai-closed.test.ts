import { ApiError } from "@adclub/api-client";
import { describe, expect, it } from "vitest";
import { recognitionFailureOf } from "../garage/document-flow";
import { voiceFailureOf, voiceFailureOpensList } from "../speech/voice-input";
import { assistantFailureOf, assistantLimitSheetOf } from "./assistant-rules";
import { guestAiClosed } from "./guest-ai-closed";

/** The refusal of the switch `guest_attestation_required` as the API client throws it. */
const closed = new ApiError({
  status: 403,
  code: "GUEST_SIGN_IN_REQUIRED",
  message: "AI features are for signed-in people only right now",
  retryable: false,
});

describe("AI for signed-in people only (TASK-066)", () => {
  it("is the refusal GUEST_SIGN_IN_REQUIRED and nothing else", () => {
    expect(guestAiClosed(closed)).toBe(true);
    expect(guestAiClosed({ code: "FORBIDDEN" })).toBe(false);
    expect(guestAiClosed({ code: "RATE_LIMITED" })).toBe(false);
    expect(guestAiClosed(null)).toBe(false);
    expect(guestAiClosed(new Error("x"))).toBe(false);
  });

  it("the assistant: M-AI-02 «Пробные запросы временно недоступны» with «Войти»", () => {
    const failure = assistantFailureOf(closed, false);
    expect(failure).toEqual({ kind: "guest_budget" });
    expect(assistantLimitSheetOf(failure)).toBe("guest_budget");
    expect(assistantLimitSheetOf(assistantFailureOf(closed, true))).toBe("guest_budget");
  });

  it("voice — the search, the mileage, a car: the same sheet; adding a car then opens «Выбрать из списка»", () => {
    expect(voiceFailureOf(closed, false)).toEqual({ limit: "guest_budget" });
    // The sheet reports a limit as «limit» to the screen that adds a car.
    expect(voiceFailureOpensList("limit")).toBe(true);
  });

  it("a photo — the certificate, the dashboard, a part: its own state with «Войти»", () => {
    expect(recognitionFailureOf(closed)).toBe("guest_closed");
    // Not the trial spent and not «unavailable»: those say other things.
    expect(
      recognitionFailureOf({
        code: "RATE_LIMITED",
        details: { limit: "vehicle_document_per_device" },
      }),
    ).toBe("limit");
    expect(recognitionFailureOf({ code: "VEHICLE_DOCUMENT_UNAVAILABLE" })).toBe("unavailable");
  });
});
