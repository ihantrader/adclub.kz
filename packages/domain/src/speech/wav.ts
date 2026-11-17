/**
 * The one sound format of voice input (TASK-059; ARCHITECTURE 4.90): WAV
 * with 16-bit PCM. The app writes it itself on iOS, Android and in a
 * browser from the PCM the microphone gives (`encodeWav`), so the server
 * takes one format and checks it by its content (`readWav`), as a photo is
 * checked (4.22) — never by the declared type. Nothing is transcoded.
 */

/** What the app records: mono, 16 kHz — enough for speech, about 32 KB a second. */
export const SPEECH_SAMPLE_RATE = 16_000;

/** A WAV the server reads, as its header says it. */
export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: 16;
  /** Bytes of sound (the `data` chunk). */
  dataBytes: number;
  /** How long the sound is, seconds. */
  seconds: number;
  /** The text of the `LIST/INFO/ICMT` chunk, if any (the synthetic samples carry their code there). */
  comment: string | null;
}

/**
 * Why bytes are not a recording the server reads:
 * - `not_audio` — not a sound file at all (a picture, a text);
 * - `unsupported_format` — a sound file of another format (`detected` says
 *   which): the app sends WAV only;
 * - `unsupported_encoding` — a WAV, but not 16-bit PCM (8-bit, float,
 *   compressed);
 * - `broken` — a WAV cut short or with sizes that do not add up;
 * - `empty` — no sound in it.
 */
export type WavRejection =
  | { reason: "not_audio" }
  | { reason: "unsupported_format"; detected: string }
  | { reason: "unsupported_encoding" }
  | { reason: "broken" }
  | { reason: "empty" };

export type WavReading = { ok: true; wav: WavInfo } | ({ ok: false } & WavRejection);

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[offset + index]!);
  }
  return text;
}

/** Other sound formats by their first bytes — named in the refusal, never read. */
function otherAudioFormat(bytes: Uint8Array): string | null {
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (ascii(bytes, 4, 4) === "ftyp") return "mp4";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "webm";
  }
  if (ascii(bytes, 0, 4) === "FORM" && ascii(bytes, 8, 4) === "AIFF") return "aiff";
  if (ascii(bytes, 0, 6) === "#!AMR\n") return "amr";
  // MPEG audio (MP3) or AAC ADTS: a frame sync of eleven set bits.
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    return ((bytes[1] ?? 0) & 0x06) === 0 ? "aac" : "mp3";
  }
  return null;
}

/**
 * The longest comment read: the samples carry a short code there. A comment
 * is client bytes, so it is cut before anything is done with it and trailing
 * zeros are dropped by a plain loop (a pattern like `/\0+$/` backtracks
 * quadratically on a megabyte of zeros and froze the process — acceptance
 * of TASK-059).
 */
const MAX_COMMENT_BYTES = 256;

/** The comment of a `LIST` chunk of the kind `INFO` (`ICMT`), if it has one. */
function infoComment(bytes: Uint8Array, view: DataView, start: number, end: number): string | null {
  if (ascii(bytes, start, 4) !== "INFO") return null;
  let offset = start + 4;
  while (offset + 8 <= end) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > end) return null;
    if (id === "ICMT") {
      let length = Math.min(size, MAX_COMMENT_BYTES);
      while (length > 0 && bytes[offset + 8 + length - 1] === 0) length -= 1;
      return ascii(bytes, offset + 8, length);
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Reads a WAV by its content: the RIFF header, the `fmt ` chunk (16-bit PCM,
 * plain or «extensible» with the PCM subformat), the `data` chunk and an
 * optional comment. Whatever the bytes are, the answer is a reading or a
 * reason — never an exception.
 */
export function readWav(input: Uint8Array): WavReading {
  const bytes = input;
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    const detected = otherAudioFormat(bytes);
    return detected
      ? { ok: false, reason: "unsupported_format", detected }
      : { ok: false, reason: "not_audio" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: {
    tag: number;
    channels: number;
    sampleRate: number;
    bits: number;
    block: number;
  } | null = null;
  let dataBytes: number | null = null;
  let comment: string | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "data") {
      // One sound only: a second `data` would let a short last chunk pass the
      // length check while a decoder plays the long first one.
      if (dataBytes !== null) return { ok: false, reason: "broken" };
      const available = bytes.length - body;
      // A writer that streamed the sound may leave the size unknown (0 or all ones).
      if (declared === 0 || declared === 0xffffffff) dataBytes = available;
      else if (declared > available) return { ok: false, reason: "broken" };
      else dataBytes = declared;
      offset = body + dataBytes + (dataBytes % 2);
      continue;
    }
    if (body + declared > bytes.length) return { ok: false, reason: "broken" };
    if (id === "fmt ") {
      if (declared < 16 || format !== null) return { ok: false, reason: "broken" };
      let tag = view.getUint16(body, true);
      if (tag === WAVE_FORMAT_EXTENSIBLE && declared >= 26) {
        // The first two bytes of the subformat GUID are the format tag.
        tag = view.getUint16(body + 24, true);
      }
      format = {
        tag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        block: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "LIST") {
      comment = infoComment(bytes, view, body, body + declared) ?? comment;
    }
    offset = body + declared + (declared % 2);
  }
  if (!format || dataBytes === null) return { ok: false, reason: "broken" };
  if (format.tag !== WAVE_FORMAT_PCM || format.bits !== 16) {
    return { ok: false, reason: "unsupported_encoding" };
  }
  if (
    format.channels < 1 ||
    format.channels > 2 ||
    format.sampleRate < 8_000 ||
    format.sampleRate > 48_000 ||
    format.block !== format.channels * 2
  ) {
    return { ok: false, reason: "unsupported_encoding" };
  }
  const frames = Math.floor(dataBytes / format.block);
  if (frames === 0) return { ok: false, reason: "empty" };
  return {
    ok: true,
    wav: {
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitsPerSample: 16,
      dataBytes,
      seconds: frames / format.sampleRate,
      comment,
    },
  };
}

/**
 * A WAV of 16-bit PCM from samples — what the app sends. `comment` goes into
 * a `LIST/INFO/ICMT` chunk (only the synthetic samples have one).
 */
export function encodeWav(
  samples: Int16Array,
  sampleRate: number,
  options: { channels?: number; comment?: string } = {},
): Uint8Array {
  const channels = options.channels ?? 1;
  const dataBytes = samples.length * 2;
  let list: Uint8Array | null = null;
  if (options.comment !== undefined) {
    const text = `${options.comment}\0`;
    const padded = text.length + (text.length % 2);
    list = new Uint8Array(4 + 8 + padded);
    const listView = new DataView(list.buffer);
    writeAscii(list, 0, "INFO");
    writeAscii(list, 4, "ICMT");
    listView.setUint32(8, text.length, true);
    writeAscii(list, 12, text);
  }
  const listBytes = list ? 8 + list.length : 0;
  const total = 12 + 24 + listBytes + 8 + dataBytes;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, "RIFF");
  view.setUint32(4, total - 8, true);
  writeAscii(out, 8, "WAVE");
  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  let offset = 36;
  if (list) {
    writeAscii(out, offset, "LIST");
    view.setUint32(offset + 4, list.length, true);
    out.set(list, offset + 8);
    offset += 8 + list.length;
  }
  writeAscii(out, offset, "data");
  view.setUint32(offset + 4, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(offset + 8 + index * 2, samples[index]!, true);
  }
  return out;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index) & 0xff;
  }
}

/** Float samples of −1…1 (a browser's microphone) as 16-bit PCM. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]!));
    out[index] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }
  return out;
}

/**
 * Mono 16-bit PCM at `to` Hz from samples at `from` Hz: averaging when the
 * rate goes down (a browser records at 44.1 or 48 kHz), the nearest sample
 * otherwise. Speech needs no better filter at 16 kHz.
 */
export function resamplePcm16(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  const ratio = from / to;
  const length = Math.floor(samples.length / ratio);
  const out = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let source = start; source < end && source < samples.length; source += 1) {
      sum += samples[source]!;
      count += 1;
    }
    out[index] = count === 0 ? 0 : Math.round(sum / count);
  }
  return out;
}

/**
 * The sound of a WAV the server reads, as mono 16-bit samples at its own rate
 * (two channels are averaged); `null` — not such a WAV. The dev substitution
 * of the microphone plays a sample file through it.
 */
export function wavSamples(input: Uint8Array): { samples: Int16Array; sampleRate: number } | null {
  const read = readWav(input);
  if (!read.ok) return null;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 12;
  while (offset + 8 <= input.length) {
    const size = view.getUint32(offset + 4, true);
    if (ascii(input, offset, 4) === "data") {
      const channels = read.wav.channels;
      const frames = Math.floor(read.wav.dataBytes / (channels * 2));
      const samples = new Int16Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
          sum += view.getInt16(offset + 8 + (frame * channels + channel) * 2, true);
        }
        samples[frame] = Math.round(sum / channels);
      }
      return { samples, sampleRate: read.wav.sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * A buffer of the microphone (16-bit, interleaved) as mono samples at
 * `SPEECH_SAMPLE_RATE`, whatever rate and channels the device delivered.
 */
export function toSpeechPcm(data: ArrayBuffer, sampleRate: number, channels: number): Int16Array {
  const raw = new Int16Array(data);
  let mono = raw;
  if (channels > 1) {
    mono = new Int16Array(Math.floor(raw.length / channels));
    for (let frame = 0; frame < mono.length; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel += 1)
        sum += raw[frame * channels + channel]!;
      mono[frame] = Math.round(sum / channels);
    }
  }
  return resamplePcm16(mono, sampleRate, SPEECH_SAMPLE_RATE);
}
