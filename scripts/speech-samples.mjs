// The synthetic speech set for voice input (TASK-059, D-058):
// `pnpm speech:samples` speaks every phrase with a voice of Windows
// (System.Speech — no network: `scripts/speech-tts.ps1`), makes the noise
// and silence samples, writes each as the app records — WAV, 16 kHz,
// 16-bit, mono — with its code in a `LIST/INFO/ICMT` chunk
// («adclub-speech-sample:N», how the test AI provider knows it), and writes
// `ai-eval/speech/samples.json` with what each sample says. `pnpm
// speech:samples --check` only checks the files against `samples.json`
// (the voices exist only on Windows, so the check needs none).
//
// Russian and English only: Windows has no Kazakh voice, and a synthetic
// voice says nothing about a person in a car anyway. Live recordings of
// people — Kazakh, Russian, mixed speech, a car's noise — go to
// `ai-eval/speech/recordings/` (not in git, `recordings.example.json`).
//
// TASK-060 added phrases said into the other fields — the mileage, a car to
// add, a message to the assistant — each with its `purpose` (absent — the
// search line). `--only id,id` speaks only those and keeps the other files
// as they are (a voice of another Windows may sound a little different).
//
// Usage: node scripts/speech-samples.mjs [--check] [--only id,id]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "ai-eval", "speech");
const RATE = 16_000;
const MAX_SECONDS = 15;
const IRINA = "Microsoft Irina Desktop";
const ZIRA = "Microsoft Zira Desktop";
const DAVID = "Microsoft David Desktop";

/**
 * The samples. `say` — what the voice is given (spelled out as a person
 * would say it); `expected` — what a person would type for it, every
 * acceptable spelling (the score takes the closest); `article` — the
 * article that must come out exactly; `noise` — the car's noise mixed in.
 */
const SAMPLES = [
  {
    id: "ru-pads-atlas",
    code: 1,
    lang: "ru",
    voice: IRINA,
    say: "колодки на атлас",
    expected: ["колодки на атлас"],
  },
  {
    id: "ru-brake-pads-geely",
    code: 2,
    lang: "ru",
    voice: IRINA,
    say: "тормозные колодки для джили атлас",
    expected: ["тормозные колодки для джили атлас", "тормозные колодки для geely atlas"],
  },
  {
    id: "ru-oil-5w30",
    code: 3,
    lang: "ru",
    voice: IRINA,
    say: "моторное масло пять дабл ю тридцать",
    expected: ["моторное масло 5w30", "моторное масло 5w 30"],
  },
  {
    id: "ru-oil-change",
    code: 4,
    lang: "ru",
    voice: IRINA,
    say: "замена масла",
    expected: ["замена масла"],
  },
  {
    id: "ru-cabin-filter",
    code: 5,
    lang: "ru",
    voice: IRINA,
    say: "салонный фильтр на кулрей",
    expected: ["салонный фильтр на кулрей", "салонный фильтр на coolray"],
  },
  {
    id: "ru-spark-plugs",
    code: 6,
    lang: "ru",
    voice: IRINA,
    say: "свечи зажигания",
    expected: ["свечи зажигания"],
  },
  {
    id: "ru-battery",
    code: 7,
    lang: "ru",
    voice: IRINA,
    say: "аккумулятор шестьдесят ампер",
    expected: ["аккумулятор 60 ампер", "аккумулятор шестьдесят ампер"],
  },
  {
    id: "ru-winter-tires",
    code: 8,
    lang: "ru",
    voice: IRINA,
    say: "зимние шины двести пятнадцать шестьдесят пять эр семнадцать",
    expected: ["зимние шины 215 65 r17", "зимние шины 215 65 р17", "зимние шины 215 65 17"],
  },
  {
    id: "ru-mileage",
    code: 9,
    lang: "ru",
    voice: IRINA,
    say: "пробег сорок пять тысяч двести километров",
    expected: ["пробег 45200 километров", "пробег 45200 км"],
  },
  {
    id: "ru-shock",
    code: 10,
    lang: "ru",
    voice: IRINA,
    say: "передний амортизатор",
    expected: ["передний амортизатор"],
  },
  {
    id: "ru-antifreeze",
    code: 11,
    lang: "ru",
    voice: IRINA,
    say: "антифриз зелёный",
    expected: ["антифриз зеленый"],
  },
  {
    id: "ru-wipers",
    code: 12,
    lang: "ru",
    voice: IRINA,
    say: "щётки стеклоочистителя",
    expected: ["щетки стеклоочистителя"],
  },
  {
    id: "ru-article-geely",
    code: 13,
    lang: "ru",
    voice: IRINA,
    say: "ноль четыре четыре шесть пять, ноль, кей, ноль девять ноль",
    expected: ["04465 0k090", "044650k090"],
    article: "044650K090",
  },
  {
    id: "ru-article-rear",
    code: 14,
    lang: "ru",
    voice: IRINA,
    say: "четыре ноль пять ноль ноль шесть восемь восемь ноль ноль",
    expected: ["4050068800"],
    article: "4050068800",
  },
  {
    id: "ru-diagnostics",
    code: 15,
    lang: "ru",
    voice: IRINA,
    say: "компьютерная диагностика двигателя",
    expected: ["компьютерная диагностика двигателя"],
  },
  {
    id: "ru-pads-atlas-noise",
    code: 16,
    lang: "ru",
    voice: IRINA,
    say: "колодки на атлас",
    expected: ["колодки на атлас"],
    noise: 0.04,
  },
  {
    id: "ru-article-geely-noise",
    code: 17,
    lang: "ru",
    voice: IRINA,
    say: "ноль четыре четыре шесть пять, ноль, кей, ноль девять ноль",
    expected: ["04465 0k090", "044650k090"],
    article: "044650K090",
    noise: 0.04,
  },
  {
    id: "en-brake-pads",
    code: 20,
    lang: "en",
    voice: ZIRA,
    say: "brake pads for geely atlas",
    expected: ["brake pads for geely atlas"],
  },
  {
    id: "en-engine-oil",
    code: 21,
    lang: "en",
    voice: ZIRA,
    say: "engine oil five w thirty",
    expected: ["engine oil 5w30", "engine oil 5w 30"],
  },
  {
    id: "en-air-filter",
    code: 22,
    lang: "en",
    voice: DAVID,
    say: "air filter",
    expected: ["air filter"],
  },
  {
    id: "en-spark-plugs",
    code: 23,
    lang: "en",
    voice: DAVID,
    say: "spark plugs for coolray",
    expected: ["spark plugs for coolray"],
  },
  {
    id: "en-article-trw",
    code: 24,
    lang: "en",
    voice: ZIRA,
    say: "G, D, B, three five three four",
    expected: ["gdb3534", "gdb 3534"],
    article: "GDB3534",
  },
  {
    id: "en-article-man",
    code: 25,
    lang: "en",
    voice: DAVID,
    say: "M, A, N, six seven five two seven",
    expected: ["man67527", "man 67527"],
    article: "MAN67527",
  },
  // TASK-060: the mileage field (M-GAR-07, M-REM-02).
  {
    id: "ru-mileage-field",
    code: 40,
    lang: "ru",
    purpose: "mileage",
    voice: IRINA,
    say: "сорок пять тысяч двести километров",
    expected: ["45200 километров", "45200 км", "45200"],
  },
  {
    id: "ru-mileage-words",
    code: 41,
    lang: "ru",
    purpose: "mileage",
    voice: IRINA,
    say: "сто двадцать тысяч",
    expected: ["120000", "сто двадцать тысяч"],
  },
  {
    id: "en-mileage-field",
    code: 42,
    lang: "en",
    purpose: "mileage",
    voice: ZIRA,
    say: "forty five thousand two hundred kilometers",
    expected: ["45200 kilometers", "45200 km", "45200"],
  },
  // TASK-060: a car to add (M-START-05, M-GAR-02).
  {
    id: "ru-car-atlas",
    code: 43,
    lang: "ru",
    purpose: "vehicle",
    voice: IRINA,
    say: "джили атлас две тысячи двадцать третьего года",
    expected: ["geely atlas 2023 года", "geely atlas 2023", "джили атлас 2023 года"],
  },
  {
    id: "ru-car-coolray",
    code: 44,
    lang: "ru",
    purpose: "vehicle",
    voice: IRINA,
    say: "джили кулрей две тысячи двадцать четыре, полтора литра",
    expected: ["geely coolray 2024 1.5 литра", "geely coolray 2024 полтора литра"],
  },
  {
    id: "ru-car-unknown",
    code: 45,
    lang: "ru",
    purpose: "vehicle",
    voice: IRINA,
    say: "тойота камри две тысячи двадцатого года",
    expected: ["toyota camry 2020", "toyota camry 2020 года", "тойота камри 2020 года"],
  },
  {
    id: "en-car-tiggo",
    code: 46,
    lang: "en",
    purpose: "vehicle",
    voice: DAVID,
    say: "chery tiggo seven pro, twenty twenty two",
    expected: ["chery tiggo 7 pro 2022"],
  },
  // TASK-060: a message to the assistant (M-AI-01).
  {
    id: "ru-assistant-squeak",
    code: 47,
    lang: "ru",
    purpose: "assistant",
    voice: IRINA,
    say: "скрипит при торможении, что посмотреть",
    expected: ["скрипит при торможении что посмотреть"],
  },
  { id: "silence", code: 30, lang: null, kind: "silence", seconds: 2.5, expected: [""] },
  { id: "car-noise", code: 31, lang: null, kind: "noise", seconds: 3, expected: [""] },
];

// ---------------------------------------------------------------- WAV

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The 16-bit mono PCM and the comment of a WAV this script reads (its own and SAPI's). */
function readPcm(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") throw new Error("not a WAV");
  let offset = 12;
  let format = null;
  let data = null;
  let comment = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        tag: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = new Int16Array(
        bytes.buffer.slice(bytes.byteOffset + body, bytes.byteOffset + body + size),
      );
    } else if (
      id === "LIST" &&
      ascii(bytes, body, 4) === "INFO" &&
      ascii(bytes, body + 4, 4) === "ICMT"
    ) {
      const length = view.getUint32(body + 8, true);
      comment = ascii(bytes, body + 12, length).replace(/\0+$/, "");
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data) throw new Error("no fmt or data");
  return { ...format, samples: data, comment };
}

function encodeWav(samples, comment) {
  const text = `${comment}\0`;
  const padded = text.length + (text.length % 2);
  const listSize = 4 + 8 + padded;
  const total = 12 + 24 + 8 + listSize + 8 + samples.length * 2;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const put = (offset, value) => {
    for (let index = 0; index < value.length; index += 1)
      out[offset + index] = value.charCodeAt(index);
  };
  put(0, "RIFF");
  view.setUint32(4, total - 8, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, "LIST");
  view.setUint32(40, listSize, true);
  put(44, "INFO");
  put(48, "ICMT");
  view.setUint32(52, text.length, true);
  put(56, text);
  const data = 44 + listSize;
  put(data, "data");
  view.setUint32(data + 4, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(data + 8 + index * 2, samples[index], true);
  }
  return out;
}

// ---------------------------------------------------------------- sound

/** A small deterministic generator: the same noise on every run. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The noise of a car on the move: a low rumble (white noise through a
 * one-pole low-pass) with a little hiss on top, at the RMS asked.
 */
function carNoise(length, rms, seed) {
  const next = random(seed);
  const out = new Float64Array(length);
  let low = 0;
  for (let index = 0; index < length; index += 1) {
    const white = next() * 2 - 1;
    low += 0.04 * (white - low);
    out[index] = low * 6 + white * 0.15;
  }
  const current = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0) / length);
  return out.map((value) => (value / current) * rms);
}

function toPcm(values) {
  return Int16Array.from(values, (value) =>
    Math.max(-32768, Math.min(32767, Math.round(value * 32767))),
  );
}

function withPadding(samples, seconds) {
  const pad = Math.round(seconds * RATE);
  const out = new Int16Array(samples.length + pad * 2);
  out.set(samples, pad);
  return out;
}

function speak(sample, scratch) {
  const textFile = join(scratch, `${sample.id}.txt`);
  const wavFile = join(scratch, `${sample.id}.wav`);
  writeFileSync(textFile, sample.say, "utf8");
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "speech-tts.ps1"),
      "-Voice",
      sample.voice,
      "-TextFile",
      textFile,
      "-Out",
      wavFile,
    ],
    { stdio: "inherit" },
  );
  const read = readPcm(new Uint8Array(readFileSync(wavFile)));
  if (read.rate !== RATE || read.channels !== 1 || read.bits !== 16) {
    throw new Error(
      `${sample.id}: the voice wrote ${read.rate} Hz, ${read.channels} channels, ${read.bits} bits`,
    );
  }
  let samples = withPadding(read.samples, 0.4);
  if (sample.noise) {
    const noise = carNoise(samples.length, sample.noise, sample.code);
    samples = Int16Array.from(samples, (value, index) =>
      Math.max(-32768, Math.min(32767, value + Math.round(noise[index] * 32767))),
    );
  }
  return samples;
}

function made(sample) {
  const length = Math.round(sample.seconds * RATE);
  // Silence of a quiet room: not digital zeros.
  return toPcm(carNoise(length, sample.kind === "silence" ? 0.0015 : 0.06, sample.code));
}

function describe(sample, seconds) {
  return {
    id: sample.id,
    code: sample.code,
    lang: sample.lang,
    ...(sample.purpose ? { purpose: sample.purpose } : {}),
    ...(sample.voice ? { voice: sample.voice, say: sample.say } : { kind: sample.kind }),
    ...(sample.noise ? { noise: sample.noise } : {}),
    expected: sample.expected,
    article: sample.article ?? null,
    seconds: Math.round(seconds * 100) / 100,
    file: `samples/${sample.id}.wav`,
  };
}

function manifest(described) {
  return `${JSON.stringify(
    {
      version: 1,
      note: "Synthetic speech (TASK-059): Windows voices without network, made-up phrases. Generated by scripts/speech-samples.mjs — do not edit by hand. WAV, 16 kHz, 16-bit, mono; the code is in the ICMT chunk.",
      samples: described,
    },
    null,
    2,
  )}\n`;
}

const check = process.argv.includes("--check");
const onlyAt = process.argv.indexOf("--only");
const only =
  onlyAt < 0 ? null : new Set((process.argv[onlyAt + 1] ?? "").split(",").filter(Boolean));
if (only) {
  for (const id of only) {
    if (!SAMPLES.some((sample) => sample.id === id)) throw new Error(`No sample ${id}`);
  }
}
const described = [];
const problems = [];
if (check) {
  for (const sample of SAMPLES) {
    const path = join(OUT, "samples", `${sample.id}.wav`);
    if (!existsSync(path)) {
      problems.push(`${sample.id}: no file`);
      continue;
    }
    const read = readPcm(new Uint8Array(readFileSync(path)));
    const seconds = read.samples.length / RATE;
    if (read.comment !== `adclub-speech-sample:${sample.code}`)
      problems.push(`${sample.id}: the code is ${read.comment}`);
    if (read.rate !== RATE || read.channels !== 1 || read.bits !== 16)
      problems.push(`${sample.id}: not 16 kHz mono 16-bit`);
    if (seconds > MAX_SECONDS)
      problems.push(`${sample.id}: ${seconds} s, longer than ${MAX_SECONDS}`);
    described.push(describe(sample, seconds));
  }
  const current = existsSync(join(OUT, "samples.json"))
    ? readFileSync(join(OUT, "samples.json"), "utf8")
    : "";
  // Compared as data: the file in the repository is formatted by Prettier (`pnpm format`).
  const same = (() => {
    try {
      return (
        JSON.stringify(JSON.parse(current)) === JSON.stringify(JSON.parse(manifest(described)))
      );
    } catch {
      return false;
    }
  })();
  if (!same) problems.push("samples.json is not what the files and the script say");
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error("Run: pnpm speech:samples (on Windows)");
    process.exit(1);
  }
  console.log(`speech samples: ${SAMPLES.length} up to date`);
} else {
  const scratch = mkdtempSync(join(tmpdir(), "speech-samples-"));
  mkdirSync(join(OUT, "samples"), { recursive: true });
  try {
    for (const sample of SAMPLES) {
      if (only && !only.has(sample.id)) {
        // Kept as it is: only its length is read for the list.
        const kept = readPcm(
          new Uint8Array(readFileSync(join(OUT, "samples", `${sample.id}.wav`))),
        );
        described.push(describe(sample, kept.samples.length / RATE));
        continue;
      }
      const samples = sample.voice ? speak(sample, scratch) : made(sample);
      const seconds = samples.length / RATE;
      if (seconds > MAX_SECONDS)
        throw new Error(`${sample.id}: ${seconds} s is longer than ${MAX_SECONDS}`);
      writeFileSync(
        join(OUT, "samples", `${sample.id}.wav`),
        encodeWav(samples, `adclub-speech-sample:${sample.code}`),
      );
      described.push(describe(sample, seconds));
      console.log(`${sample.id}: ${seconds.toFixed(2)} s`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, "samples.json"), manifest(described), "utf8");
  console.log(`speech samples: ${SAMPLES.length} written to ${OUT}`);
}
