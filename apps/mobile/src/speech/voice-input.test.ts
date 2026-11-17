import { describe, expect, it } from "vitest";
import { createRecordingBuffer, SPEECH_MAX_SECONDS } from "./speech-port";
import {
  stillRecognizedText,
  voiceAnswerWanted,
  voiceFailureOf,
  voiceOnAppState,
  voiceOutcomeOf,
  voiceStartOf,
} from "./voice-input";

const attempts = { scope: "guest" as const, remaining: 4, limit: 5 };

function tone(seconds: number, amplitude: number): Int16Array {
  const out = new Int16Array(Math.round(seconds * 16_000));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Math.round(Math.sin((2 * Math.PI * 220 * index) / 16_000) * amplitude * 32_767);
  }
  return out;
}

describe("the sheet when the app leaves and returns (TASK-059.A)", () => {
  it("keeps the sheet while the system asks about the microphone", () => {
    // iOS: the question makes the app `inactive`; Android: `background`.
    expect(voiceOnAppState("asking", "inactive")).toBe("keep");
    expect(voiceOnAppState("asking", "background")).toBe("keep");
    expect(voiceOnAppState("asking", "active")).toBe("keep");
  });

  it("throws the recording away when the app is put away with the sheet open", () => {
    expect(voiceOnAppState("open", "background")).toBe("discard");
    expect(voiceOnAppState("open", "inactive")).toBe("discard");
    expect(voiceOnAppState("open", "active")).toBe("keep");
  });

  it("does nothing once the sheet is closed", () => {
    for (const next of ["active", "inactive", "background"]) {
      expect(voiceOnAppState("closed", next)).toBe("keep");
    }
  });

  it("wants an answer only for the open sheet's latest start", () => {
    expect(voiceAnswerWanted(3, { generation: 3, visible: true })).toBe(true);
    // Closed while the system asked: the granted permission does not record.
    expect(voiceAnswerWanted(3, { generation: 3, visible: false })).toBe(false);
    // Something newer was started (a second press, a retry, a close).
    expect(voiceAnswerWanted(3, { generation: 4, visible: true })).toBe(false);
  });
});

describe("voice input in the search (M-CAT-05)", () => {
  it("explains before the system asks, and sends to the settings once it will not ask again", () => {
    expect(voiceStartOf({ status: "granted", canAskAgain: true })).toBe("record");
    expect(voiceStartOf({ status: "undetermined", canAskAgain: true })).toBe("explain");
    // Android asks again after one refusal: the explanation comes again too.
    expect(voiceStartOf({ status: "denied", canAskAgain: true })).toBe("explain");
    expect(voiceStartOf({ status: "denied", canAskAgain: false })).toBe("denied");
  });

  it("puts what was heard into the line, and says «Не расслышали» for nothing", () => {
    expect(voiceOutcomeOf({ text: "колодки на атлас", heard: true, cut: false, attempts })).toEqual(
      {
        kind: "text",
        text: "колодки на атлас",
      },
    );
    expect(voiceOutcomeOf({ text: "", heard: false, cut: false, attempts })).toEqual({
      kind: "not_heard",
    });
    expect(voiceOutcomeOf({ text: "а", heard: true, cut: false, attempts }).kind).toBe("not_heard");
  });

  it("opens M-AI-02 for the limits and says the rest in the sheet", () => {
    const refusal = (code: string, details?: unknown) => ({ code, status: 400, details });
    expect(voiceFailureOf(refusal("RATE_LIMITED", { limit: "speech_per_device" }), false)).toEqual({
      limit: "guest_trial",
    });
    expect(
      voiceFailureOf(refusal("RATE_LIMITED", { limit: "speech_requests_per_ip" }), false),
    ).toBe("unavailable");
    expect(voiceFailureOf(refusal("RATE_LIMITED", { limit: "speech_per_ip" }), false)).toEqual({
      limit: "guest_trial",
    });
    expect(voiceFailureOf(refusal("RATE_LIMITED", { limit: "speech_per_account" }), true)).toEqual({
      limit: "day",
    });
    expect(
      voiceFailureOf(refusal("SPEECH_UNAVAILABLE", { reason: "budget", attempts }), false),
    ).toEqual({ limit: "guest_budget" });
    // The whole day's budget for a person, the provider down: unavailable.
    expect(voiceFailureOf(refusal("SPEECH_UNAVAILABLE", { reason: "budget" }), true)).toBe(
      "unavailable",
    );
    expect(voiceFailureOf(refusal("SPEECH_UNAVAILABLE", { reason: "provider" }), false)).toBe(
      "unavailable",
    );
    expect(voiceFailureOf(refusal("NETWORK_ERROR"), false)).toBe("offline");
    expect(voiceFailureOf(refusal("PAYLOAD_TOO_LARGE", { reason: "duration" }), false)).toBe(
      "too_long",
    );
    expect(voiceFailureOf(refusal("SPEECH_INVALID", { reason: "broken" }), false)).toBe(
      "unavailable",
    );
    expect(voiceFailureOf(new Error("anything"), false)).toBe("unavailable");
  });

  it("keeps «распознано» until the person edits the line", () => {
    expect(stillRecognizedText("колодки на атлас ", "колодки на атлас")).toBe(true);
    expect(stillRecognizedText("колодки на атлас 2023", "колодки на атлас")).toBe(false);
  });
});

describe("one recording in memory", () => {
  it("stops by itself after speech and a pause, and gives a WAV the server reads", () => {
    const updates: number[] = [];
    let stopped = 0;
    const buffer = createRecordingBuffer({
      onUpdate: (state) => updates.push(state.level),
      onAutoStop: () => (stopped += 1),
    });
    buffer.push(tone(0.5, 0.001));
    buffer.push(tone(1, 0.3));
    for (let index = 0; index < 20; index += 1) buffer.push(tone(0.1, 0.001));
    expect(stopped).toBe(1);
    expect(updates.length).toBeGreaterThan(0);
    // After it stopped nothing more is kept.
    buffer.push(tone(1, 0.3));
    const capture = buffer.capture();
    expect(capture.heardAnything).toBe(true);
    expect(capture.seconds).toBeCloseTo(3.1, 1);
    expect(String.fromCharCode(...capture.wav.subarray(0, 4))).toBe("RIFF");
  });

  it("stops at the limit, and a quiet recording is not one to send", () => {
    let stopped = 0;
    const buffer = createRecordingBuffer({
      onUpdate: () => undefined,
      onAutoStop: () => (stopped += 1),
    });
    buffer.push(tone(SPEECH_MAX_SECONDS + 1, 0.001));
    expect(stopped).toBe(1);
    const capture = buffer.capture();
    expect(capture.seconds).toBeLessThanOrEqual(SPEECH_MAX_SECONDS + 1);
    expect(capture.heardAnything).toBe(false);
  });
});
