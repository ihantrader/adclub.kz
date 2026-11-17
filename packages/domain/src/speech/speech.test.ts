import { describe, expect, it } from "vitest";
import {
  createSpeechWatch,
  levelOfRms,
  pcmRms,
  speechHeardAnything,
  SPEECH_SILENCE_STOP_MS,
} from "./speech-level";
import { cleanSpeechText, speechAttemptCharge, SPEECH_TEXT_MAX_LENGTH } from "./speech-text";
import {
  encodeWav,
  floatToPcm16,
  readWav,
  resamplePcm16,
  SPEECH_SAMPLE_RATE,
  toSpeechPcm,
  wavSamples,
} from "./wav";

function tone(seconds: number, amplitude: number, rate = SPEECH_SAMPLE_RATE): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Math.round(Math.sin((2 * Math.PI * 220 * index) / rate) * amplitude * 32_767);
  }
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const bytesOf = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe("the format of a recording, by its content", () => {
  it("reads the WAV the app writes, its length and its comment", () => {
    const wav = encodeWav(tone(2.5, 0.3), SPEECH_SAMPLE_RATE, {
      comment: "adclub-speech-sample:7",
    });
    const read = readWav(wav);
    expect(read).toEqual({
      ok: true,
      wav: {
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        dataBytes: 80_000,
        seconds: 2.5,
        comment: "adclub-speech-sample:7",
      },
    });
    expect(readWav(encodeWav(tone(1, 0.3), 16_000))).toMatchObject({
      ok: true,
      wav: { comment: null },
    });
  });

  it("names other sound formats and refuses what is not sound at all", () => {
    expect(readWav(bytesOf("OggS\0\x02rest of an opus file"))).toEqual({
      ok: false,
      reason: "unsupported_format",
      detected: "ogg",
    });
    expect(readWav(bytesOf("\0\0\0\x20ftypM4A \0\0\0\0"))).toMatchObject({ detected: "mp4" });
    expect(readWav(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4))).toMatchObject({
      detected: "webm",
    });
    expect(readWav(bytesOf("ID3\x04\0\0\0\0\0\0"))).toMatchObject({ detected: "mp3" });
    expect(readWav(Uint8Array.of(0xff, 0xf1, 0x50, 0x80))).toMatchObject({ detected: "aac" });
    expect(readWav(bytesOf("fLaC\0\0\0\x22"))).toMatchObject({ detected: "flac" });
    // A JPEG with a .wav name, a text, nothing.
    expect(readWav(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16))).toEqual({
      ok: false,
      reason: "not_audio",
    });
    expect(readWav(bytesOf("just some text, not a recording"))).toEqual({
      ok: false,
      reason: "not_audio",
    });
    expect(readWav(new Uint8Array(0))).toEqual({ ok: false, reason: "not_audio" });
  });

  it("refuses a WAV that is not 16-bit PCM, is cut short or holds no sound", () => {
    const wav = encodeWav(tone(1, 0.3), 16_000);
    const float = wav.slice();
    new DataView(float.buffer).setUint16(20, 3, true);
    expect(readWav(float)).toEqual({ ok: false, reason: "unsupported_encoding" });
    const eightBit = wav.slice();
    new DataView(eightBit.buffer).setUint16(34, 8, true);
    expect(readWav(eightBit)).toEqual({ ok: false, reason: "unsupported_encoding" });
    expect(readWav(wav.slice(0, 1000))).toEqual({ ok: false, reason: "broken" });
    expect(readWav(wav.slice(0, 30))).toEqual({ ok: false, reason: "broken" });
    expect(readWav(encodeWav(new Int16Array(0), 16_000))).toEqual({ ok: false, reason: "empty" });
    // A streaming writer that never went back for the size: the rest of the file is the sound.
    const streamed = wav.slice();
    new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
    expect(readWav(streamed)).toMatchObject({ ok: true, wav: { seconds: 1 } });
  });

  it("reads a megabyte of zeros in a comment at once and refuses a second sound (acceptance)", () => {
    // ICMT of a million zeros and one letter: a backtracking pattern took minutes on it.
    const zeros = "\0".repeat(1_000_000);
    const wav = encodeWav(tone(0.5, 0.3), 16_000, { comment: `${zeros}x` });
    const started = Date.now();
    const read = readWav(wav);
    expect(Date.now() - started).toBeLessThan(500);
    expect(read).toMatchObject({ ok: true, wav: { seconds: 0.5 } });
    // Only the first 256 bytes are read: all zeros here, so no comment text.
    expect(read.ok && read.wav.comment).toBe("");
    expect(
      readWav(encodeWav(tone(0.5, 0.3), 16_000, { comment: "adclub-speech-sample:3\0\0\0" })),
    ).toMatchObject({ ok: true, wav: { comment: "adclub-speech-sample:3" } });

    // Two `data` chunks (a long first, a short last) or two `fmt ` — broken.
    const long = encodeWav(tone(2, 0.3), 16_000);
    const short = encodeWav(tone(0.2, 0.3), 16_000);
    const twoData = new Uint8Array(long.length + short.length - 36);
    twoData.set(long, 0);
    twoData.set(short.subarray(36), long.length);
    new DataView(twoData.buffer).setUint32(4, twoData.length - 8, true);
    expect(readWav(twoData)).toEqual({ ok: false, reason: "broken" });
    const twoFmt = new Uint8Array(long.length + 24);
    twoFmt.set(long.subarray(0, 36), 0);
    twoFmt.set(long.subarray(12, 36), 36);
    twoFmt.set(long.subarray(36), 60);
    new DataView(twoFmt.buffer).setUint32(4, twoFmt.length - 8, true);
    expect(readWav(twoFmt)).toEqual({ ok: false, reason: "broken" });
  });

  it("turns a browser's float samples at 48 kHz into 16 kHz PCM", () => {
    expect(Array.from(floatToPcm16(Float32Array.of(-1, -0.5, 0, 0.5, 1, 2)))).toEqual([
      -32768, -16384, 0, 16384, 32767, 32767,
    ]);
    const down = resamplePcm16(tone(1, 0.5, 48_000), 48_000, 16_000);
    expect(down.length).toBe(16_000);
    expect(pcmRms(down)).toBeGreaterThan(0.3);
    expect(resamplePcm16(Int16Array.of(1, 2, 3), 16_000, 16_000)).toEqual(Int16Array.of(1, 2, 3));
    // A stereo buffer of a phone at 32 kHz: averaged, then halved.
    const stereo = Int16Array.of(100, 300, 100, 300, 500, 700, 500, 700);
    expect(Array.from(toSpeechPcm(stereo.buffer, 32_000, 2))).toEqual([200, 600]);
  });

  it("gives back the sound of a WAV for the substitution of the microphone", () => {
    const sound = tone(0.5, 0.3);
    expect(wavSamples(encodeWav(sound, 16_000, { comment: "x" }))).toEqual({
      samples: sound,
      sampleRate: 16_000,
    });
    expect(wavSamples(Uint8Array.of(1, 2, 3))).toBeNull();
  });
});

describe("the level and when a recording stops by itself", () => {
  it("shows the level and stops after speech and a pause, not on silence alone", () => {
    expect(levelOfRms(0)).toBe(0);
    expect(levelOfRms(1)).toBe(1);
    const watch = createSpeechWatch({ sampleRate: 16_000, maxSeconds: 15 });
    // Silence before the person starts: the recording waits.
    expect(watch.push(tone(3, 0.001))).toMatchObject({ spoke: false, stop: null });
    const speaking = watch.push(tone(1, 0.3));
    expect(speaking).toMatchObject({ spoke: true, stop: null });
    expect(speaking.level).toBeGreaterThan(0.5);
    expect(watch.push(tone(1, 0.001))).toMatchObject({ stop: null });
    expect(watch.push(tone(SPEECH_SILENCE_STOP_MS / 1000, 0.001))).toMatchObject({
      stop: "silence",
    });
  });

  it("stops at the length limit whatever is heard", () => {
    const watch = createSpeechWatch({ sampleRate: 16_000, maxSeconds: 15 });
    expect(watch.push(tone(14.9, 0.3)).stop).toBeNull();
    expect(watch.push(tone(0.2, 0.3))).toMatchObject({ stop: "limit" });
  });

  it("does not send a recording in which nothing could be speech", () => {
    expect(speechHeardAnything(tone(3, 0.002), 16_000)).toBe(false);
    expect(speechHeardAnything(concat(tone(1, 0.002), tone(0.5, 0.2)), 16_000)).toBe(true);
    // A click is not speech.
    expect(speechHeardAnything(concat(tone(1, 0.002), tone(0.05, 0.5)), 16_000)).toBe(false);
  });
});

describe("the recognised text as the search line takes it", () => {
  it("keeps the words and drops what a model adds", () => {
    expect(cleanSpeechText("Колодки на Атлас.")).toEqual({
      text: "Колодки на Атлас",
      heard: true,
      cut: false,
    });
    expect(cleanSpeechText("«масло 5W-30»").text).toBe("масло 5W-30");
    expect(cleanSpeechText("Транскрипция: колодки [шум] на атлас").text).toBe("колодки на атлас");
    expect(cleanSpeechText("<noise> brake pads (inaudible) for atlas").text).toBe(
      "brake pads for atlas",
    );
    expect(cleanSpeechText("тежегіш қалыптары\n\nатлас")).toMatchObject({
      text: "тежегіш қалыптары атлас",
    });
    // Round brackets of ordinary words stay: a person may say them.
    expect(cleanSpeechText("фильтр (салонный)").text).toBe("фильтр (салонный)");
    const hidden = String.fromCharCode(0x200b);
    const bell = String.fromCharCode(7);
    expect(cleanSpeechText(`04465${hidden}-0K090${bell}`).text).toBe("04465-0K090");
  });

  it("says nothing was heard for silence, marks and punctuation", () => {
    for (const raw of [
      "",
      "   ",
      "[тишина]",
      "(no speech)",
      "...",
      "«»",
      "*кашель*",
      "<silence>",
    ]) {
      expect(cleanSpeechText(raw), raw).toEqual({ text: "", heard: false, cut: false });
    }
  });

  it("cuts a long text by a word to the search line", () => {
    const long = `${"колодки ".repeat(20)}конец`;
    const cleaned = cleanSpeechText(long);
    expect(cleaned.cut).toBe(true);
    expect(cleaned.text.length).toBeLessThanOrEqual(SPEECH_TEXT_MAX_LENGTH);
    expect(cleaned.text.endsWith("колодки")).toBe(true);
    // One word longer than the line is cut where the line ends.
    expect(cleanSpeechText("x".repeat(150)).text).toHaveLength(SPEECH_TEXT_MAX_LENGTH);
    expect(cleanSpeechText("a".repeat(100))).toMatchObject({ cut: false });
  });
});

describe("whether a recognition costs an attempt", () => {
  it("counts only what reached the model", () => {
    expect(speechAttemptCharge("too_large")).toBe("not_counted");
    expect(speechAttemptCharge("invalid")).toBe("not_counted");
    expect(speechAttemptCharge("provider_unavailable")).toBe("given_back");
    expect(speechAttemptCharge("budget_spent")).toBe("given_back");
    expect(speechAttemptCharge("transcribed")).toBe("spent");
  });
});
