import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanSpeechText, encodeWav, readWav } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import { speechSampleCode, TEST_SPEECH, TestAiGateway } from "../ai";
import {
  loadSpeechEvalData,
  scoreSpeech,
  speechEvalDirectory,
  speechWords,
  wordErrorRate,
} from ".";
import { articleHeard } from "./eval/speech-eval-score";

const SIGNAL = new AbortController().signal;

describe("the synthetic speech set and the test AI provider (TASK-059)", () => {
  const data = loadSpeechEvalData("synthetic");

  it("is WAV the server reads, each with its code, none longer than 15 s", () => {
    expect(data.samples.length).toBeGreaterThanOrEqual(20);
    for (const sample of data.samples) {
      const bytes = new Uint8Array(readFileSync(join(speechEvalDirectory(), sample.file)));
      const read = readWav(bytes);
      expect(read.ok, sample.id).toBe(true);
      if (!read.ok) continue;
      expect(read.wav.sampleRate, sample.id).toBe(16_000);
      expect(read.wav.seconds, sample.id).toBeLessThanOrEqual(15);
      expect(speechSampleCode(bytes), sample.id).not.toBeNull();
    }
  });

  it("answers for every sample what a person would type, once the server cleans it", async () => {
    const gateway = new TestAiGateway();
    const answers = new Map<string, string>();
    for (const sample of data.samples) {
      const audio = new Uint8Array(readFileSync(join(speechEvalDirectory(), sample.file)));
      const result = await gateway.transcribeSpeech(
        { audio, format: "wav", seconds: 3, language: "ru", purpose: sample.purpose },
        "test/model",
        SIGNAL,
      );
      const text = cleanSpeechText((result.output as { text: string }).text, 1000).text;
      answers.set(sample.id, text);
      const code = speechSampleCode(audio)!;
      expect(TEST_SPEECH[code], sample.id).toBeDefined();
      expect(wordErrorRate(text, sample.expected).errors, `${sample.id}: «${text}»`).toBe(0);
      if (sample.article) expect(articleHeard(text, sample.article), sample.id).toBe(true);
    }
    // The stand-in is a perfect model: the score of the comparison says so.
    const score = scoreSpeech(data.samples, answers);
    expect(score.passes).toBe(true);
    expect(score.misses).toEqual([]);
    expect(score.silence).toEqual({ empty: 2, total: 2 });
    // The table has no code the set does not use.
    const codes = data.samples.map((sample) =>
      speechSampleCode(new Uint8Array(readFileSync(join(speechEvalDirectory(), sample.file))))!,
    );
    expect(
      Object.keys(TEST_SPEECH)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([...codes].sort((a, b) => a - b));
  });

  it("hears nothing in a recording without a code, and in the mode unreadable", async () => {
    const gateway = new TestAiGateway();
    const plain = encodeWav(new Int16Array(16_000), 16_000);
    const sample = encodeWav(new Int16Array(16_000), 16_000, { comment: "adclub-speech-sample:1" });
    const hear = async (audio: Uint8Array) =>
      (
        (
          await gateway.transcribeSpeech(
            { audio, format: "wav", seconds: 1, language: "ru", purpose: "mileage" },
            "m",
            SIGNAL,
          )
        ).output as { text: string }
      ).text;
    expect(await hear(plain)).toBe("");
    expect(await hear(sample)).toBe("Колодки на атлас.");
    gateway.mode = "unreadable";
    expect(await hear(sample)).toBe("");
    gateway.mode = "unavailable";
    await expect(hear(sample)).rejects.toMatchObject({ kind: "unavailable" });
    // Only the size and the length were noted — never the sound.
    expect(gateway.speechRequests[0]).toEqual({
      bytes: plain.length,
      seconds: 1,
      language: "ru",
      purpose: "mileage",
      model: "m",
    });
  });
});

describe("the score of the comparison", () => {
  it("compares words as a person types them", () => {
    expect(speechWords("Моторное масло 5W-30.")).toEqual(["моторное", "масло", "5w30"]);
    expect(speechWords("Пробег 45 200 км")).toEqual(["пробег", "45200", "км"]);
    expect(speechWords("Шины 215/65 R17")).toEqual(["шины", "215", "65", "r17"]);
    expect(speechWords("щётки")).toEqual(["щетки"]);
    expect(wordErrorRate("колодки на атлас", ["колодки на атлас"]).rate).toBe(0);
    expect(wordErrorRate("колодки атлас", ["колодки на атлас"])).toMatchObject({
      errors: 1,
      words: 3,
    });
    // The closest of the acceptable spellings.
    expect(wordErrorRate("для Geely Atlas", ["для джили атлас", "для geely atlas"]).rate).toBe(0);
    // Silence: nothing is right, a word is wrong.
    expect(wordErrorRate("", [""]).errors).toBe(0);
    expect(wordErrorRate("ну", [""]).errors).toBe(1);
  });

  it("reads an article as the search does, lookalike letters taken as Latin", () => {
    expect(articleHeard("04465 0K090", "04465-0K090")).toBe(true);
    expect(articleHeard("04465-0К090", "04465-0K090")).toBe(true);
    expect(articleHeard("0446 50 K 090", "04465-0K090")).toBe(true);
    expect(articleHeard("04465 OK090", "04465-0K090")).toBe(false);
    expect(articleHeard("ноль четыре", "04465-0K090")).toBe(false);
  });
});
