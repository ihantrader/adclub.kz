// The synthetic sample set for reading the mileage off a photo of the
// dashboard (TASK-058, D-058): `pnpm dashboard:samples` draws every sample
// of `ai-eval/dashboard/` and writes `samples.json` — the expected values
// next to the pictures, as data; `pnpm dashboard:samples --check` only
// checks that `samples.json` and the list of pictures are up to date.
//
// Everything here is made up and drawn: instrument clusters in several
// styles (a green LCD, white and amber digits, a light display, a thin
// font), the odometer in kilometres or miles, a trip meter next to the
// total — once in larger digits than the total — and pictures that are not
// a dashboard at all. Real photos are never put in the repository.
//
// Usage: node scripts/dashboard-samples.mjs [--check]
import { join } from "node:path";
import { photograph, root, svgOf, text, watermark, writeSet } from "./photo-sample-kit.mjs";

const OUT = join(root, "ai-eval", "dashboard");
const CANVAS = { width: 1600, height: 1100 };

const STYLES = {
  lcd: { panel: "#0f1418", screen: "#0b2a1a", digits: "#7ef29a", font: "Courier New" },
  white: { panel: "#15191e", screen: "#05070a", digits: "#f2f5f7", font: "Arial" },
  amber: { panel: "#1b1712", screen: "#120c04", digits: "#ffb340", font: "Consolas" },
  light: { panel: "#2a2f35", screen: "#c9d2c3", digits: "#1a2316", font: "Courier New" },
  thin: { panel: "#101418", screen: "#06080b", digits: "#cfe8ff", font: "Arial Narrow" },
};

/** «45 200» — as an odometer groups its digits. */
function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * The samples. `total` is the number on the panel, in `unit`; `trip` — a
 * trip meter next to it (`tripBig` — in larger digits than the total).
 * `expected` is what the server should answer.
 */
const SAMPLES = [
  { id: "lcd-45200-clean", code: 1, style: "lcd", total: 45_200, unit: "km", variant: "clean" },
  { id: "lcd-45200-glare", code: 2, style: "lcd", total: 45_200, unit: "km", variant: "glare" },
  { id: "lcd-45200-tilt", code: 3, style: "lcd", total: 45_200, unit: "km", variant: "tilt" },
  {
    id: "white-128450-clean",
    code: 4,
    style: "white",
    total: 128_450,
    unit: "km",
    variant: "clean",
  },
  {
    id: "white-128450-lowres",
    code: 5,
    style: "white",
    total: 128_450,
    unit: "km",
    variant: "lowres",
  },
  { id: "amber-32000-clean", code: 6, style: "amber", total: 32_000, unit: "km", variant: "clean" },
  { id: "light-7350-clean", code: 7, style: "light", total: 7_350, unit: "km", variant: "clean" },
  { id: "thin-210987-clean", code: 8, style: "thin", total: 210_987, unit: "km", variant: "clean" },
  {
    id: "white-64310-occluded",
    code: 9,
    style: "white",
    total: 64_310,
    unit: "km",
    variant: "occluded",
  },
  {
    id: "amber-91200-digits-covered",
    code: 10,
    style: "amber",
    total: 91_200,
    unit: "km",
    variant: "occluded_digits",
    readable: false,
  },
  {
    id: "white-28087mi-clean",
    code: 11,
    style: "white",
    total: 28_087,
    unit: "mi",
    variant: "clean",
  },
  { id: "lcd-61500mi-glare", code: 12, style: "lcd", total: 61_500, unit: "mi", variant: "glare" },
  {
    id: "white-89400-trip-big",
    code: 13,
    style: "white",
    total: 89_400,
    unit: "km",
    trip: 1234.5,
    tripBig: true,
    variant: "clean",
  },
  {
    id: "amber-156020-trip",
    code: 14,
    style: "amber",
    total: 156_020,
    unit: "km",
    trip: 412.7,
    variant: "clean",
  },
  {
    id: "lcd-503120-trip-tilt",
    code: 15,
    style: "lcd",
    total: 503_120,
    unit: "km",
    trip: 88.1,
    variant: "tilt",
  },
  {
    id: "light-45200-blur",
    code: 16,
    style: "light",
    total: 45_200,
    unit: "km",
    variant: "blur",
    readable: false,
  },
  { id: "white-ignition-off", code: 17, style: "white", off: true, variant: "clean" },
  {
    id: "thin-18750-lowres",
    code: 18,
    style: "thin",
    total: 18_750,
    unit: "km",
    variant: "lowres",
  },
  { id: "amber-12-new-car", code: 19, style: "amber", total: 12, unit: "km", variant: "clean" },
  {
    id: "light-73004-glare",
    code: 20,
    style: "light",
    total: 73_004,
    unit: "km",
    trip: 6.2,
    variant: "glare",
  },
  { id: "not-dashboard-car", code: 30, other: "car", variant: "clean" },
  { id: "not-dashboard-phone-note", code: 31, other: "phone_note", variant: "clean" },
  { id: "not-dashboard-part-box", code: 32, other: "part_box", variant: "tilt" },
];

// ------------------------------------------------------------- drawing

function gauge(cx, cy, r, label, angle, style) {
  const ticks = [];
  for (let i = 0; i <= 12; i += 1) {
    const a = ((-210 + i * 20) * Math.PI) / 180;
    ticks.push(
      `<line x1="${cx + Math.cos(a) * (r - 30)}" y1="${cy + Math.sin(a) * (r - 30)}" x2="${cx + Math.cos(a) * (r - 6)}" y2="${cy + Math.sin(a) * (r - 6)}" stroke="#9aa7b4" stroke-width="5"/>`,
    );
  }
  const needle = (angle * Math.PI) / 180;
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0a0d10" stroke="#55626f" stroke-width="8"/>`,
    ...ticks,
    `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(needle) * (r - 40)}" y2="${cy + Math.sin(needle) * (r - 40)}" stroke="#e8573a" stroke-width="10" stroke-linecap="round"/>`,
    `<circle cx="${cx}" cy="${cy}" r="18" fill="#2b3239"/>`,
    text(cx, cy + r * 0.55, label, {
      size: 34,
      fill: "#9aa7b4",
      anchor: "middle",
      font: style.font,
    }),
  ].join("");
}

function dashboard(sample) {
  const style = STYLES[sample.style];
  const w = 1500;
  const h = 820;
  const parts = [
    `<rect width="${w}" height="${h}" rx="90" fill="${style.panel}"/>`,
    gauge(340, 380, 260, sample.unit === "mi" ? "MPH" : "km/h", sample.off ? -210 : -60, style),
    gauge(1160, 380, 260, "x1000 rpm", sample.off ? -210 : -150, style),
    `<rect x="560" y="470" width="380" height="${sample.trip ? 250 : 180}" rx="18" fill="${style.screen}" stroke="#3a4550" stroke-width="4"/>`,
  ];
  if (!sample.off) {
    const unit = sample.unit === "mi" ? "mi" : "km";
    const totalSize = sample.tripBig ? 40 : 66;
    const tripSize = sample.tripBig ? 70 : 36;
    parts.push(
      text(580, 510, "ODO", { size: 26, fill: style.digits, font: style.font, opacity: 0.8 }),
      text(920, sample.tripBig ? 560 : 590, `${grouped(sample.total)} ${unit}`, {
        size: totalSize,
        weight: "bold",
        fill: style.digits,
        font: style.font,
        anchor: "end",
      }),
    );
    if (sample.trip) {
      parts.push(
        text(580, sample.tripBig ? 610 : 640, "TRIP A", {
          size: 24,
          fill: style.digits,
          font: style.font,
          opacity: 0.8,
        }),
        text(920, sample.tripBig ? 690 : 690, `${sample.trip.toFixed(1)} ${unit}`, {
          size: tripSize,
          weight: "bold",
          fill: style.digits,
          font: style.font,
          anchor: "end",
        }),
      );
    }
    parts.push(
      text(750, 450, "-18°C  12:40", {
        size: 30,
        fill: "#9aa7b4",
        anchor: "middle",
        font: style.font,
      }),
    );
  }
  parts.push(watermark(w, h, "#ff7a7a"));
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

function car() {
  const w = 1500;
  const h = 820;
  const parts = [
    `<rect width="${w}" height="${h}" fill="#b9d4e8"/>`,
    `<rect y="560" width="${w}" height="260" fill="#6f7a6a"/>`,
    `<path d="M260 560 L360 400 Q420 330 560 320 L940 320 Q1060 330 1130 420 L1260 470 Q1320 490 1320 560 Z" fill="#c8302c"/>`,
    `<rect x="440" y="350" width="230" height="110" rx="14" fill="#cfe3f1"/>`,
    `<rect x="700" y="350" width="260" height="110" rx="14" fill="#cfe3f1"/>`,
    `<circle cx="470" cy="580" r="85" fill="#222"/><circle cx="470" cy="580" r="40" fill="#999"/>`,
    `<circle cx="1110" cy="580" r="85" fill="#222"/><circle cx="1110" cy="580" r="40" fill="#999"/>`,
    `<rect x="700" y="500" width="180" height="46" fill="#ffffff" stroke="#111" stroke-width="3"/>`,
    text(790, 534, "777 ABC 02", { size: 30, weight: "bold", anchor: "middle", font: "Arial" }),
    watermark(w, h),
  ];
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

function phoneNote() {
  const w = 760;
  const h = 1300;
  const parts = [
    `<rect width="${w}" height="${h}" rx="70" fill="#1a1a1a"/>`,
    `<rect x="30" y="80" width="${w - 60}" height="${h - 160}" rx="30" fill="#fbf7e8"/>`,
    text(80, 200, "Заметки", { size: 52, weight: "bold", fill: "#c08a00" }),
    text(80, 320, "Купить масло 5W-30", { size: 40, fill: "#222" }),
    text(80, 400, "Пробег при замене: 45 210 км", { size: 40, fill: "#222" }),
    text(80, 480, "Следующая замена: 55 000", { size: 40, fill: "#222" }),
    watermark(w, h),
  ];
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

function partBox() {
  const w = 1300;
  const h = 800;
  const parts = [
    `<rect width="${w}" height="${h}" fill="#f1f1ec" stroke="#888" stroke-width="6"/>`,
    `<rect width="${w}" height="160" fill="#1f4f9a"/>`,
    text(60, 110, "BRAKE PADS · ТОРМОЗНЫЕ КОЛОДКИ", { size: 54, weight: "bold", fill: "#fff" }),
    text(60, 300, "Front axle / Передняя ось", { size: 44, fill: "#222" }),
    text(60, 420, "Qty: 4 pcs", { size: 44, fill: "#222" }),
    watermark(w, h),
  ];
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

function background() {
  const { width, height } = CANVAS;
  return svgOf(width, height, [
    `<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2d31"/><stop offset="1" stop-color="#121416"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#b)"/>`,
    `<path d="M0 ${height * 0.8} Q ${width / 2} ${height * 0.7} ${width} ${height * 0.8} L ${width} ${height} L 0 ${height} Z" fill="#1b1d20"/>`,
  ]);
}

function drawnOf(sample) {
  if (sample.other === "car") return car();
  if (sample.other === "phone_note") return phoneNote();
  if (sample.other === "part_box") return partBox();
  return dashboard(sample);
}

// --------------------------------------------------------------- run

const KM_PER_MILE = 1.609344;

function entryOf(sample) {
  const readable = sample.readable ?? !sample.other;
  let expected;
  if (sample.other) {
    expected = { kind: "not_dashboard", mileageKm: null, unit: null, tripMeterSeen: false };
  } else if (sample.off || sample.readable === false) {
    expected = { kind: "unreadable", mileageKm: null, unit: null, tripMeterSeen: false };
  } else {
    expected = {
      kind: "dashboard",
      totalShown: sample.total,
      mileageKm: sample.unit === "mi" ? Math.round(sample.total * KM_PER_MILE) : sample.total,
      unit: sample.unit,
      tripMeterSeen: sample.trip !== undefined,
    };
  }
  return {
    id: sample.id,
    code: sample.code,
    variant: sample.variant,
    style: sample.other ?? (sample.off ? "ignition_off" : sample.style),
    // A total a person could read: the thresholds of D-058 are counted on these.
    readable: readable && !sample.off,
    // A blurred panel or digits under a thumb: the right reading or «не читается» — both fine.
    ...(sample.readable === false && !sample.off
      ? { acceptKinds: ["dashboard", "unreadable"], hiddenKm: sample.total }
      : {}),
    expected,
  };
}

{
  const byId = new Map(SAMPLES.map((sample) => [sample.id, sample]));
  await writeSet({
    directory: OUT,
    note: "Synthetic samples with made-up data (TASK-058). Generated by scripts/dashboard-samples.mjs — do not edit by hand.",
    samples: SAMPLES.map(entryOf),
    draw: (entry) =>
      photograph(drawnOf(byId.get(entry.id)), {
        variant: entry.variant,
        code: entry.code,
        canvas: CANVAS,
        background: background(),
      }),
  });
}
