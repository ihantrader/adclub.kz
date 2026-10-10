// The synthetic sample set for reading a vehicle registration certificate
// (TASK-057, D-064, D-058): `pnpm vehicle-document:samples` draws every
// sample of `ai-eval/vehicle-document/` and writes `samples.json` — the
// expected values next to the pictures, as data.
//
// Everything here is made up: no real person, car, VIN or plate. The forms
// are drawn approximations of the Kazakhstan certificate (the card issued
// since 2018 and the older paper form), of a Russian «СТС» and a Kazakhstan
// driving licence — not copies of any official blank — and every one is
// marked «ОБРАЗЕЦ / SAMPLE». Real documents of people are never put in the
// repository.
//
// Each picture carries a control strip in the top left corner: eleven
// cells, black or white — a start pair, eight bits of the sample's code and
// a closing cell. The test AI provider reads the code instead of the text
// (`apps/api/src/modules/ai/test-vehicle-documents.ts`, same geometry), so
// development and tests recognise the samples without calling anything.
//
// Usage: node scripts/vehicle-document-samples.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps", "api", "package.json"));
const sharp = require("sharp");

const OUT = join(root, "ai-eval", "vehicle-document");
const PICTURES = join(OUT, "samples");

/** The strip, as a share of the picture's width (the decoder uses the same). */
const MARKER = { margin: 0.015, cell: 0.03 };

const CANVAS = { width: 1600, height: 1150 };

// ------------------------------------------------------------------ data

/** Made-up cars; codes 1–8 are the certificates the test provider knows. */
const CARS = {
  coolray: {
    code: 1,
    form: "new",
    make: "GEELY",
    model: "COOLRAY",
    year: 2024,
    vin: "L6T7844Z0RN001234",
    plate: "777 ABC 02",
    cc: 1477,
    color: "СЕРЫЙ",
    colorId: "gray",
    category: "B",
    massEmpty: 1340,
    massMax: 1800,
    owner: "ТЕСТОВ ТЕСТ ТЕСТОВИЧ",
    address: "Г. АЛМАТЫ, УЛ. ВЫМЫШЛЕННАЯ, Д. 1, КВ. 1",
    series: "AA 00012345",
    issued: "14.03.2024",
    firstRegistration: "14.03.2024",
  },
  atlas: {
    code: 2,
    form: "new",
    make: "GEELY",
    model: "ATLAS",
    year: 2023,
    vin: "L6T79P4E5PE004567",
    plate: "123 KZA 01",
    cc: 1969,
    color: "БЕЛЫЙ",
    colorId: "white",
    category: "B",
    massEmpty: 1665,
    massMax: 2130,
    owner: "ПРИМЕРОВА ОБРАЗЦА ПРОБНОВНА",
    address: "Г. АСТАНА, ПР. НЕСУЩЕСТВУЮЩИЙ, Д. 99",
    series: "AB 00067890",
    issued: "02.11.2023",
    firstRegistration: "02.11.2023",
  },
  monjaro: {
    code: 3,
    form: "new",
    make: "GEELY",
    model: "MONJARO",
    year: 2024,
    vin: "L6T7944Z7RU008901",
    plate: "505 MNJ 17",
    cc: 1969,
    color: "ЧЕРНЫЙ",
    colorId: "black",
    category: "B",
    massEmpty: 1770,
    massMax: 2250,
    owner: "ВЫДУМАНОВ АЛИБЕК",
    address: "Г. ШЫМКЕНТ, МКР. УСЛОВНЫЙ, Д. 7",
    series: "AC 00011111",
    issued: "21.06.2024",
    firstRegistration: "21.06.2024",
  },
  tiggo: {
    code: 4,
    form: "new",
    make: "CHERY",
    model: "TIGGO 7 PRO",
    year: 2022,
    vin: "LVTDB21B8ND112233",
    plate: "090 TGR 05",
    cc: 1498,
    color: "СИНИЙ",
    colorId: "blue",
    category: "B",
    massEmpty: 1490,
    massMax: 1950,
    owner: "ОБРАЗЦОВ ДАНИЯР",
    address: "Г. КАРАГАНДА, УЛ. ПРИДУМАННАЯ, Д. 12",
    series: "AD 00022222",
    issued: "09.09.2022",
    firstRegistration: "09.09.2022",
  },
  camry: {
    code: 5,
    form: "new",
    make: "TOYOTA",
    model: "CAMRY",
    year: 2019,
    vin: "JTNB11HK403045678",
    plate: "404 CAM 02",
    cc: 2487,
    color: "СЕРЕБРИСТЫЙ",
    colorId: "silver",
    category: "B",
    massEmpty: 1550,
    massMax: 2100,
    owner: "НЕСУЩЕСТВУЮЩАЯ АЙГУЛЬ",
    address: "Г. АЛМАТЫ, УЛ. ЛЮБАЯ, Д. 5",
    series: "AE 00033333",
    issued: "17.01.2020",
    firstRegistration: "17.01.2020",
  },
  emgrand: {
    code: 6,
    form: "new",
    make: "GEELY",
    model: "EMGRAND",
    year: 2021,
    vin: "L6T7724S1MN012345",
    plate: "211 EMG 04",
    cc: 1498,
    color: "КРАСНЫЙ",
    colorId: "red",
    category: "B",
    massEmpty: 1240,
    massMax: 1680,
    owner: "ТЕСТОВА ЖАНАР",
    address: "Г. АКТОБЕ, УЛ. ПРОБНАЯ, Д. 3",
    series: "AF 00044444",
    issued: "30.07.2021",
    firstRegistration: "30.07.2021",
  },
  atlasOld: {
    code: 7,
    form: "old",
    make: "GEELY",
    model: "ATLAS",
    year: 2018,
    vin: "L6T79P4E8JE076543",
    plate: "B 456 KLM",
    cc: 2378,
    color: "ТЕМНО-СИНИЙ",
    colorId: "darkBlue",
    category: "B",
    massEmpty: 1610,
    massMax: 2050,
    owner: "УСЛОВНЫЙ ЕРЛАН",
    address: "АЛМАТИНСКАЯ ОБЛ., С. ВЫМЫШЛЕННОЕ",
    series: "KZ 0987654",
    issued: "05.10.2018",
    firstRegistration: "05.10.2018",
  },
  accentOld: {
    code: 8,
    form: "old",
    make: "HYUNDAI",
    model: "ACCENT",
    year: 2015,
    vin: "KMHCT41DAFU765432",
    plate: "315 ACC 09",
    cc: 1591,
    color: "БЕЖЕВЫЙ",
    colorId: "beige",
    category: "B",
    massEmpty: 1100,
    massMax: 1550,
    owner: "ПРОБНЫЙ МАРАТ",
    address: "Г. КАРАГАНДА, МКР. ПРИМЕРНЫЙ, Д. 44",
    series: "KZ 0123987",
    issued: "11.04.2015",
    firstRegistration: "11.04.2015",
  },
};

/** The samples: a car or another picture, and how it was "photographed". */
const SAMPLES = [
  ...["coolray", "atlas", "monjaro", "tiggo", "camry", "emgrand", "atlasOld", "accentOld"].map(
    (car) => ({ car, variant: "clean" }),
  ),
  { car: "coolray", variant: "glare" },
  { car: "coolray", variant: "tilt" },
  { car: "coolray", variant: "blur" },
  { car: "coolray", variant: "occluded" },
  { car: "coolray", variant: "lowres" },
  { car: "atlas", variant: "glare" },
  { car: "atlas", variant: "tilt" },
  { car: "atlas", variant: "lowres" },
  { car: "tiggo", variant: "tilt" },
  { car: "tiggo", variant: "blur" },
  { car: "atlasOld", variant: "glare" },
  { car: "atlasOld", variant: "tilt" },
  { other: "ru_sts", code: 20, variant: "clean" },
  { other: "kz_license", code: 21, variant: "clean" },
  { other: "kz_license", code: 21, variant: "tilt" },
  { other: "not_document", code: 30, variant: "clean" },
];

// --------------------------------------------------------------- drawing

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function text(
  x,
  y,
  value,
  { size = 20, weight = "normal", fill = "#1d2a36", font = "Arial", anchor = "start" } = {},
) {
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
}

/** Two-language label over a typed value, the way the certificate lays a field out. */
function field(
  x,
  y,
  label,
  value,
  { valueSize = 30, labelSize = 15, mono = false, width = 0 } = {},
) {
  const line =
    width > 0
      ? `<line x1="${x}" y1="${y + 8}" x2="${x + width}" y2="${y + 8}" stroke="#9fb3a6" stroke-width="1"/>`
      : "";
  return [
    text(x, y - valueSize - 6, label, { size: labelSize, fill: "#4c6155" }),
    text(x, y, value, {
      size: valueSize,
      weight: "bold",
      font: mono ? "Courier New" : "Arial",
      fill: "#101820",
    }),
    line,
  ].join("");
}

function watermark(width, height) {
  const cx = width / 2;
  const cy = height / 2;
  return `<g transform="rotate(-18 ${cx} ${cy})" opacity="0.13">${text(cx, cy - 20, "ОБРАЗЕЦ · SAMPLE", { size: Math.round(width / 11), weight: "bold", fill: "#b0262c", anchor: "middle" })}${text(cx, cy + Math.round(width / 22), "ДЕРЕКТЕР ОЙДАН ШЫҒАРЫЛҒАН · ДАННЫЕ ВЫДУМАНЫ", { size: Math.round(width / 40), weight: "bold", fill: "#b0262c", anchor: "middle" })}</g>`;
}

function guilloche(width, height, color) {
  const lines = [];
  for (let i = 0; i < 26; i += 1) {
    const y = (height / 26) * i;
    lines.push(
      `<path d="M0 ${y} Q ${width / 4} ${y - 30} ${width / 2} ${y} T ${width} ${y}" stroke="${color}" stroke-width="1" fill="none" opacity="0.35"/>`,
    );
  }
  return lines.join("");
}

/** The card of the new form (since 2018): 86 × 54 mm, drawn at 20 px per mm. */
function newCertificate(car) {
  const w = 1720;
  const h = 1080;
  const parts = [
    `<rect width="${w}" height="${h}" rx="44" fill="#e9f1ea"/>`,
    guilloche(w, h, "#7fae95"),
    `<rect x="0" y="0" width="${w}" height="150" rx="44" fill="#2f6f8f"/>`,
    `<rect x="0" y="100" width="${w}" height="50" fill="#2f6f8f"/>`,
    `<circle cx="110" cy="75" r="52" fill="#f2c94c"/><circle cx="110" cy="75" r="30" fill="#2f6f8f"/>`,
    text(200, 62, "ҚАЗАҚСТАН РЕСПУБЛИКАСЫ · РЕСПУБЛИКА КАЗАХСТАН", {
      size: 30,
      weight: "bold",
      fill: "#ffffff",
    }),
    text(200, 112, "КӨЛІК ҚҰРАЛЫН ТІРКЕУ ТУРАЛЫ КУӘЛІК · СВИДЕТЕЛЬСТВО О РЕГИСТРАЦИИ ТС", {
      size: 26,
      fill: "#e8f3f8",
    }),
    text(w - 60, 200, car.series, {
      size: 30,
      weight: "bold",
      fill: "#b0262c",
      anchor: "end",
      font: "Courier New",
    }),
    field(
      60,
      250,
      "1. Мемлекеттік тіркеу нөмірі / Государственный регистрационный номер",
      car.plate,
      { valueSize: 40, mono: true, width: 760 },
    ),
    field(60, 345, "2. Маркасы, моделі / Марка, модель", `${car.make} ${car.model}`, {
      width: 760,
    }),
    field(60, 435, "3. Шығарылған жылы / Год выпуска", String(car.year), { width: 360 }),
    field(460, 435, "4. Санаты / Категория", car.category, { width: 360 }),
    field(60, 530, "5. VIN / Идентификационный номер (VIN)", car.vin, {
      valueSize: 38,
      mono: true,
      width: 760,
    }),
    field(60, 625, "6. Түсі / Цвет", car.color, { width: 360 }),
    field(460, 625, "7. Қозғалтқыш көлемі, см³ / Объём двигателя, см³", String(car.cc), {
      width: 360,
    }),
    field(60, 720, "8. Жүксіз салмағы, кг / Масса без нагрузки, кг", String(car.massEmpty), {
      width: 360,
    }),
    field(
      460,
      720,
      "9. Рұқсат етілген ең жоғары салмағы / Разреш. макс. масса",
      String(car.massMax),
      { width: 360 },
    ),
    field(900, 345, "10. Иесі / Владелец", car.owner, { valueSize: 26, width: 760 }),
    field(900, 435, "11. Мекенжайы / Адрес", car.address, { valueSize: 22, width: 760 }),
    field(900, 530, "12. Ерекше белгілер / Особые отметки", "—", { valueSize: 26, width: 760 }),
    field(
      900,
      625,
      "13. Алғаш тіркелген күні / Дата первичной регистрации",
      car.firstRegistration,
      { valueSize: 26, width: 360 },
    ),
    field(1300, 625, "14. Берілген күні / Дата выдачи", car.issued, { valueSize: 26, width: 360 }),
    `<rect x="900" y="770" width="760" height="230" rx="16" fill="none" stroke="#7fae95" stroke-width="3"/>`,
    text(1280, 900, "М.О. / М.П.", { size: 28, fill: "#7fae95", anchor: "middle" }),
    watermark(w, h),
  ];
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

/** The older paper form: a larger green sheet, typed values. */
function oldCertificate(car) {
  const w = 1500;
  const h = 1060;
  const parts = [
    `<rect width="${w}" height="${h}" fill="#dfe9cf"/>`,
    guilloche(w, h, "#9bb07a"),
    `<rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="none" stroke="#6f8a4c" stroke-width="4"/>`,
    text(w / 2, 90, "ҚАЗАҚСТАН РЕСПУБЛИКАСЫ — РЕСПУБЛИКА КАЗАХСТАН", {
      size: 30,
      weight: "bold",
      anchor: "middle",
      fill: "#2e4220",
    }),
    text(w / 2, 135, "КӨЛІК ҚҰРАЛЫН ТІРКЕУ ТУРАЛЫ КУӘЛІК", {
      size: 26,
      anchor: "middle",
      fill: "#2e4220",
    }),
    text(w / 2, 172, "СВИДЕТЕЛЬСТВО О РЕГИСТРАЦИИ ТРАНСПОРТНОГО СРЕДСТВА", {
      size: 26,
      anchor: "middle",
      fill: "#2e4220",
    }),
    text(w - 70, 230, car.series, {
      size: 30,
      weight: "bold",
      fill: "#a1262a",
      anchor: "end",
      font: "Courier New",
    }),
    field(80, 290, "Тіркеу нөмірі / Регистрационный номер", car.plate, {
      valueSize: 38,
      mono: true,
      width: 600,
    }),
    field(80, 380, "Маркасы, моделі / Марка, модель", `${car.make} ${car.model}`, {
      mono: true,
      width: 600,
    }),
    field(80, 470, "Шығарылған жылы / Год выпуска", String(car.year), { mono: true, width: 600 }),
    field(80, 560, "Идентификациялық нөмір / Идентификационный номер (VIN)", car.vin, {
      valueSize: 36,
      mono: true,
      width: 600,
    }),
    field(80, 650, "Түсі / Цвет", car.color, { mono: true, width: 600 }),
    field(80, 740, "Қозғалтқыш көлемі / Объём двигателя, куб. см", String(car.cc), {
      mono: true,
      width: 600,
    }),
    field(80, 830, "Санаты / Категория", car.category, { mono: true, width: 600 }),
    field(780, 380, "Иесі / Собственник", car.owner, { valueSize: 26, mono: true, width: 640 }),
    field(780, 470, "Мекенжайы / Адрес", car.address, { valueSize: 20, mono: true, width: 640 }),
    field(780, 560, "Берілген күні / Дата выдачи", car.issued, {
      valueSize: 26,
      mono: true,
      width: 640,
    }),
    `<circle cx="1120" cy="800" r="120" fill="none" stroke="#5a6f9a" stroke-width="5" opacity="0.6"/>`,
    text(1120, 808, "ТІРКЕУ БӨЛІМІ", { size: 24, anchor: "middle", fill: "#5a6f9a" }),
    watermark(w, h),
  ];
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

/** A made-up Russian «СТС»: another country's certificate — not ours to read. */
function russianSts() {
  const w = 1720;
  const h = 1080;
  const parts = [
    `<rect width="${w}" height="${h}" rx="40" fill="#f6e3e8"/>`,
    guilloche(w, h, "#d79aaa"),
    text(w / 2, 90, "РОССИЙСКАЯ ФЕДЕРАЦИЯ", {
      size: 36,
      weight: "bold",
      anchor: "middle",
      fill: "#6b2737",
    }),
    text(w / 2, 140, "СВИДЕТЕЛЬСТВО О РЕГИСТРАЦИИ ТРАНСПОРТНОГО СРЕДСТВА", {
      size: 30,
      anchor: "middle",
      fill: "#6b2737",
    }),
    text(w - 60, 200, "99 00 123456", {
      size: 32,
      weight: "bold",
      fill: "#b0262c",
      anchor: "end",
      font: "Courier New",
    }),
    field(60, 270, "Регистрационный знак", "А123ВС77", { valueSize: 40, mono: true, width: 760 }),
    field(60, 370, "Идентификационный номер (VIN)", "XTA219170L0000001", {
      valueSize: 36,
      mono: true,
      width: 760,
    }),
    field(60, 470, "Марка, модель", "LADA VESTA", { width: 760 }),
    field(60, 570, "Год выпуска", "2020", { width: 360 }),
    field(60, 670, "Цвет", "БЕЛЫЙ", { width: 360 }),
    field(900, 370, "Собственник", "ИВАНОВ ВЫМЫСЕЛ ПЕТРОВИЧ", { valueSize: 26, width: 760 }),
    field(900, 470, "Регион", "Г. НЕСУЩЕСТВУЮЩИЙ", { valueSize: 26, width: 760 }),
    watermark(w, h),
  ];
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

/** A made-up Kazakhstan driving licence: a document, but not a vehicle certificate. */
function kzLicense() {
  const w = 1720;
  const h = 1080;
  const parts = [
    `<rect width="${w}" height="${h}" rx="40" fill="#e8eef8"/>`,
    guilloche(w, h, "#8aa2cc"),
    `<rect x="0" y="0" width="${w}" height="140" rx="40" fill="#2b5aa3"/><rect x="0" y="100" width="${w}" height="40" fill="#2b5aa3"/>`,
    text(60, 70, "ҚАЗАҚСТАН РЕСПУБЛИКАСЫ · РЕСПУБЛИКА КАЗАХСТАН", {
      size: 30,
      weight: "bold",
      fill: "#ffffff",
    }),
    text(60, 115, "ЖҮРГІЗУШІ КУӘЛІГІ · ВОДИТЕЛЬСКОЕ УДОСТОВЕРЕНИЕ", { size: 28, fill: "#e6eef9" }),
    `<rect x="60" y="200" width="420" height="540" rx="16" fill="#c7d1e2"/><circle cx="270" cy="380" r="110" fill="#9fb0cc"/><rect x="130" y="520" width="280" height="200" rx="120" fill="#9fb0cc"/>`,
    field(560, 260, "1. Тегі / Фамилия", "ОБРАЗЦОВА", { width: 1060 }),
    field(560, 350, "2. Аты / Имя", "ПРИМЕРНАЯ", { width: 1060 }),
    field(560, 440, "3. Туған күні / Дата рождения", "01.01.1990", { width: 500 }),
    field(560, 530, "4a. Берілген күні / Дата выдачи", "15.05.2021", { width: 500 }),
    field(1120, 530, "4b. Жарамды / Действительно до", "15.05.2031", { width: 500 }),
    field(560, 620, "5. Нөмірі / Номер", "AB 1234567", { mono: true, width: 500 }),
    field(560, 710, "9. Санаттары / Категории", "B, B1, M", { width: 500 }),
    watermark(w, h),
  ];
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

/** Not a document: a drawn dashboard. */
function notDocument() {
  const w = 1600;
  const h = 1150;
  const parts = [
    `<rect width="${w}" height="${h}" fill="#20252b"/>`,
    `<circle cx="520" cy="560" r="300" fill="#11161b" stroke="#5c6a78" stroke-width="10"/>`,
    `<circle cx="1080" cy="560" r="300" fill="#11161b" stroke="#5c6a78" stroke-width="10"/>`,
    `<line x1="520" y1="560" x2="700" y2="400" stroke="#e8573a" stroke-width="12"/>`,
    `<line x1="1080" y1="560" x2="900" y2="430" stroke="#e8573a" stroke-width="12"/>`,
    text(520, 760, "km/h", { size: 48, fill: "#cfd8e0", anchor: "middle" }),
    text(1080, 760, "x1000 rpm", { size: 48, fill: "#cfd8e0", anchor: "middle" }),
    text(800, 1000, "45 210 km", {
      size: 56,
      fill: "#9be37a",
      anchor: "middle",
      font: "Courier New",
    }),
  ];
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

function svgOf(width, height, parts) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`,
  );
}

/** A table the document lies on — the photo's background. */
function background() {
  const { width, height } = CANVAS;
  const parts = [
    `<defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a6f55"/><stop offset="1" stop-color="#5e4a39"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#t)"/>`,
  ];
  for (let i = 0; i < 40; i += 1) {
    const y = (height / 40) * i + ((i * 37) % 11);
    parts.push(
      `<path d="M0 ${y} C ${width / 3} ${y + 14} ${(2 * width) / 3} ${y - 14} ${width} ${y}" stroke="#4a3a2c" stroke-width="2" fill="none" opacity="0.25"/>`,
    );
  }
  return svgOf(width, height, parts);
}

/** The strip of the sample's code, drawn on the photo itself. */
function marker(code, width) {
  const cell = Math.round(MARKER.cell * width);
  const left = Math.round(MARKER.margin * width);
  const top = left;
  const bits = [1, 0, ...Array.from({ length: 8 }, (_, i) => (code >> (7 - i)) & 1), 1];
  const pad = Math.round(cell * 0.4);
  const parts = [
    `<rect x="${left - pad}" y="${top - pad}" width="${cell * 11 + pad * 2}" height="${cell + pad * 2}" fill="#ffffff"/>`,
    ...bits.map(
      (bit, index) =>
        `<rect x="${left + index * cell}" y="${top}" width="${cell}" height="${cell}" fill="${bit ? "#000000" : "#ffffff"}"/>`,
    ),
  ];
  return parts.join("");
}

async function documentLayer(form, car) {
  const drawn =
    form === "new"
      ? newCertificate(car)
      : form === "old"
        ? oldCertificate(car)
        : form === "ru_sts"
          ? russianSts()
          : form === "kz_license"
            ? kzLicense()
            : notDocument();
  return drawn;
}

/** The document as a photographed layer: scaled to sit on the table, with the variant applied. */
async function photographed(drawn, variant) {
  const scale = Math.min((CANVAS.width * 0.84) / drawn.width, (CANVAS.height * 0.8) / drawn.height);
  const width = Math.round(drawn.width * scale);
  const height = Math.round(drawn.height * scale);
  let layer = sharp(drawn.svg).resize(width, height).png();
  let buffer = await layer.toBuffer();
  if (variant === "glare") {
    const glare = svgOf(width, height, [
      `<defs><radialGradient id="g" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffffff" stop-opacity="0.92"/><stop offset="0.6" stop-color="#ffffff" stop-opacity="0.45"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>`,
      `<ellipse cx="${width * 0.68}" cy="${height * 0.3}" rx="${width * 0.2}" ry="${height * 0.16}" fill="url(#g)"/>`,
    ]);
    buffer = await sharp(buffer)
      .composite([{ input: glare }])
      .png()
      .toBuffer();
  }
  if (variant === "occluded") {
    // A thumb over the VIN, the way a hand holds the card.
    const thumb = svgOf(width, height, [
      `<ellipse cx="${width * 0.2}" cy="${height * 0.47}" rx="${width * 0.17}" ry="${height * 0.09}" fill="#d9a483"/>`,
      `<ellipse cx="${width * 0.24}" cy="${height * 0.46}" rx="${width * 0.06}" ry="${height * 0.05}" fill="#e7b99c"/>`,
    ]);
    buffer = await sharp(buffer)
      .composite([{ input: thumb }])
      .png()
      .toBuffer();
  }
  if (variant === "blur") {
    buffer = await sharp(buffer).blur(2.2).png().toBuffer();
  }
  if (variant === "tilt") {
    buffer = await sharp(buffer)
      .rotate(-7, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  }
  return buffer;
}

async function picture(form, car, variant, code) {
  const drawn = await documentLayer(form, car);
  const layer = await photographed(drawn, variant);
  const meta = await sharp(layer).metadata();
  const left = Math.round((CANVAS.width - meta.width) / 2);
  const top = Math.round((CANVAS.height - meta.height) / 2 + CANVAS.height * 0.03);
  const shadow = svgOf(CANVAS.width, CANVAS.height, [
    `<rect x="${left + 14}" y="${top + 18}" width="${meta.width - 10}" height="${meta.height - 10}" rx="40" fill="#000000" opacity="0.35"/>`,
  ]);
  const markerLayer = svgOf(CANVAS.width, CANVAS.height, [marker(code, CANVAS.width)]);
  let image = sharp(background()).composite([
    { input: await sharp(shadow).blur(14).png().toBuffer() },
    { input: layer, left, top },
    { input: markerLayer },
  ]);
  let buffer = await image.png().toBuffer();
  if (variant === "lowres") {
    buffer = await sharp(buffer).resize({ width: 640 }).png().toBuffer();
  }
  return sharp(buffer).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

// --------------------------------------------------------------- run

const VARIANT_READABLE = {
  clean: true,
  glare: true,
  tilt: true,
  lowres: true,
  blur: false,
  occluded: false,
};

function compactPlate(plate) {
  return plate.replace(/\s/g, "");
}

rmSync(PICTURES, { recursive: true, force: true });
mkdirSync(PICTURES, { recursive: true });

const samples = [];
for (const sample of SAMPLES) {
  const car = sample.car ? CARS[sample.car] : undefined;
  const form = car ? car.form : sample.other;
  const code = car ? car.code : sample.code;
  const id = `${car ? `${sample.car}` : sample.other}-${sample.variant}`.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`,
  );
  const file = `samples/${id}.jpg`;
  const bytes = await picture(form, car, sample.variant, code);
  writeFileSync(join(OUT, file), bytes);
  const expected = car
    ? {
        documentKind: "kz_registration",
        make: car.make,
        model: car.model,
        year: car.year,
        vin: sample.variant === "occluded" ? null : car.vin,
        plate: compactPlate(car.plate),
        engineVolumeCc: car.cc,
        color: car.color,
        colorId: car.colorId,
      }
    : {
        documentKind: form === "not_document" ? "not_document" : "other_document",
        make: null,
        model: null,
        year: null,
        vin: null,
        plate: null,
        engineVolumeCc: null,
        color: null,
        colorId: null,
      };
  samples.push({
    id,
    file,
    code,
    form,
    variant: sample.variant,
    // A photo a person could read every field of: the threshold of D-058 is
    // counted on these. Blur and a thumb over the VIN are measured, not counted.
    readable: car ? VARIANT_READABLE[sample.variant] : true,
    // What the model may answer instead of the expected kind without being wrong.
    acceptKinds:
      car && !VARIANT_READABLE[sample.variant] ? ["kz_registration", "unreadable"] : undefined,
    expected,
    // Written on the picture and never to be read out: the checks look for it in answers.
    mustNotAppear: car ? [car.owner, car.address, car.series] : [],
  });
  console.log(`${file} ${bytes.length} bytes`);
}

writeFileSync(
  join(OUT, "samples.json"),
  `${JSON.stringify({ version: 1, note: "Synthetic samples with made-up data (TASK-057). Generated by scripts/vehicle-document-samples.mjs — do not edit by hand.", samples }, null, 2)}\n`,
);
console.log(`${samples.length} samples written to ${OUT}`);
