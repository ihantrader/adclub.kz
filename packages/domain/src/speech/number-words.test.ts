import { describe, expect, it } from "vitest";
import { mileageInText } from "../assistant/mileage-in-text";
import { readVehiclePhrase, vehicleNameSpans, vehicleYearOf } from "../vehicle/vehicle-phrase";
import { numberWordsToDigits } from "./number-words";

describe("numberWordsToDigits", () => {
  it.each([
    ["сорок пять тысяч двести", "45200"],
    ["сорок пять тысяч двести километров", "45200 километров"],
    ["45 тысяч двести", "45200"],
    ["две тысячи двадцать три", "2023"],
    ["две тысячи двадцать третьего года", "2023 года"],
    ["две тысячи двадцатого", "2020"],
    ["тысяча", "1000"],
    ["сто двадцать тысяч", "120000"],
    ["полтора литра", "1.5 литра"],
    ["полторы тысячи", "1500"],
    ["қырық бес мың екі жүз", "45200"],
    ["жиырма мың", "20000"],
    ["он бес мың", "15000"],
    ["forty five thousand two hundred", "45200"],
    ["forty-five thousand", "45000"],
    ["two hundred and five", "205"],
    ["one hundred twenty thousand miles", "120000 miles"],
  ])("%s → %s", (text, digits) => {
    expect(numberWordsToDigits(text)).toBe(digits);
  });

  it("leaves digits, ordinary words and separate numbers alone", () => {
    expect(numberWordsToDigits("Geely Atlas 2023")).toBe("Geely Atlas 2023");
    expect(numberWordsToDigits("45 200 км")).toBe("45 200 км");
    // «2023 два литра» — a year and an engine size, never 2025.
    expect(numberWordsToDigits("Atlas 2023 два литра")).toBe("Atlas 2023 2 литра");
    expect(numberWordsToDigits("пять шесть")).toBe("5 6");
    // «он» and «one» alone are words, not numbers.
    expect(numberWordsToDigits("он сказал")).toBe("он сказал");
    expect(numberWordsToDigits("the one I have")).toBe("the one I have");
    // A joiner with nothing after it stays a word.
    expect(numberWordsToDigits("five and more")).toBe("5 and more");
    // The sign after a number word stays after its digits.
    expect(numberWordsToDigits("двести, триста")).toBe("200, 300");
  });
});

describe("the mileage said into the field (TASK-060)", () => {
  it.each([
    ["45 200", 45_200],
    ["45200", 45_200],
    ["45 тысяч", 45_000],
    ["45 тыс.", 45_000],
    ["45 тысяч двести", 45_200],
    ["сорок пять тысяч двести", 45_200],
    ["сорок пять тысяч двести километров", 45_200],
    ["45 200 км", 45_200],
    ["Пробег 45 200 километров", 45_200],
    ["қырық бес мың екі жүз", 45_200],
    ["45 мың шақырым", 45_000],
    ["forty five thousand two hundred", 45_200],
    ["45 thousand", 45_000],
    ["45,200 km", 45_200],
    ["сто двадцать тысяч", 120_000],
  ])("%s → %d", (text, km) => {
    expect(mileageInText(text, { field: true })).toBe(km);
  });

  it.each(["", "не знаю", "примерно сорок или пятьдесят", "45 или 46 тысяч"])(
    "%s → null",
    (text) => {
      expect(mileageInText(text, { field: true })).toBeNull();
    },
  );

  it("needs a word of mileage or a unit outside the field, as before", () => {
    expect(mileageInText("45 200")).toBeNull();
    expect(mileageInText("пробег сорок пять тысяч")).toBe(45_000);
    expect(mileageInText("20 тысяч")).toBe(20_000);
  });
});

describe("a car said by voice (TASK-060)", () => {
  it("takes out the year and the engine size", () => {
    expect(readVehiclePhrase("Geely Atlas 2023, 1,5 турбо", 2026)).toMatchObject({
      year: 2023,
      engineVolumeCc: 1500,
      words: ["Geely", "Atlas"],
    });
    expect(readVehiclePhrase("Geely Coolray 2024 1.5", 2026)).toMatchObject({
      year: 2024,
      engineVolumeCc: 1500,
    });
    expect(readVehiclePhrase("Джили Атлас две тысячи двадцать третьего года", 2026)).toMatchObject({
      year: 2023,
      engineVolumeCc: null,
      words: ["Джили", "Атлас"],
    });
    expect(readVehiclePhrase("Монжаро полтора литра", 2026)).toMatchObject({
      engineVolumeCc: 1500,
      words: ["Монжаро"],
    });
    expect(readVehiclePhrase("Tugella 2.0T 2022 года", 2026)).toMatchObject({
      year: 2022,
      engineVolumeCc: 2000,
      words: ["Tugella"],
    });
    expect(readVehiclePhrase("менің көлігім Geely Atlas 2023 жылғы", 2026)).toMatchObject({
      year: 2023,
      words: ["Geely", "Atlas"],
    });
  });

  it("drops a year of the future and one before the catalog", () => {
    expect(readVehiclePhrase("Geely Atlas 2031", 2026).year).toBeNull();
    expect(readVehiclePhrase("Geely Atlas 1931", 2026).year).toBeNull();
    // The current year is a car of this year.
    expect(readVehiclePhrase("Geely Atlas 2026", 2026).year).toBe(2026);
  });

  it("keeps a number that is a part of a model's name", () => {
    expect(readVehiclePhrase("Chery Tiggo 7 Pro 2022", 2026)).toMatchObject({
      year: 2022,
      words: ["Chery", "Tiggo", "7", "Pro"],
    });
  });

  it("names no make when nothing but a year is said", () => {
    expect(readVehiclePhrase("2023 года", 2026)).toMatchObject({
      year: 2023,
      engineVolumeCc: null,
      words: [],
    });
  });

  it("gives the runs of words with their spellings in both alphabets, longer first", () => {
    const spans = vehicleNameSpans(["Джили", "Атлас", "Про"]);
    expect(spans.map((span) => span.text)).toEqual([
      "Джили Атлас Про",
      "Джили Атлас",
      "Атлас Про",
      "Джили",
      "Атлас",
      "Про",
    ]);
    expect(spans.find((span) => span.text === "Атлас")?.spellings).toContain("atlas");
    expect(
      vehicleNameSpans(["Geely", "Coolray"]).find((span) => span.text === "Coolray")?.spellings,
    ).toContain("Coolray");
    // The words of the make are not offered for the model.
    expect(
      vehicleNameSpans(["Geely", "Atlas", "Pro"], { from: 0, to: 1 }).map((span) => span.text),
    ).toEqual(["Atlas Pro", "Atlas", "Pro"]);
  });
});

describe("numbers after the acceptance of TASK-060 (TASK-060.A)", () => {
  it.each([
    // 1. The genitive and the prepositional; «тысяч» alone is no number.
    ["около ста тысяч", "около 100000"],
    ["больше ста двадцати тысяч", "больше 120000"],
    ["до двухсот тысяч", "до 200000"],
    ["более трёхсот пятидесяти тысяч", "более 350000"],
    ["около сорока пяти тысяч", "около 45000"],
    ["о двухстах километрах", "о 200 километрах"],
    ["меньше пятидесяти", "меньше 50"],
    ["несколько тысяч", "несколько тысяч"],
    ["тысячи", "тысячи"],
    ["тыс.", "тыс."],
    ["тысяча", "1000"],
    ["мың", "1000"],
    ["thousand", "1000"],
    // 2. Ordinals of a year.
    ["две тысячи пятнадцатого года", "2015 года"],
    ["две тысячи восемнадцатого", "2018"],
    ["две тысячи девятнадцатого", "2019"],
    ["две тысячи одиннадцатого", "2011"],
    ["две тысячи десятого", "2010"],
    ["две тысячи двадцатого", "2020"],
    ["две тысячи тридцатого", "2030"],
    ["две тысячи двадцать третьего", "2023"],
    ["екі мың жиырма үшінші жылғы", "2023 жылғы"],
    ["екі мың он бесінші", "2015"],
    ["екі мың оныншы", "2010"],
    ["екі мың бірінші", "2001"],
    ["екі мың жиырмасыншы", "2020"],
    // An ordinal we do not read: no number rather than 2000.
    ["две тысячи двухтысячного", "две тысячи двухтысячного"],
    // 4. «он» is ten only with Kazakh.
    ["он пять тысяч прошёл", "он 5000 прошёл"],
    ["он бес", "15"],
    ["он мың", "10000"],
    ["екі мың он", "2010"],
  ])("%s → %s", (text, digits) => {
    expect(numberWordsToDigits(text)).toBe(digits);
  });

  it.each([
    // 1.
    ["пробег около ста тысяч", 100_000],
    // 3. «45 тысяч двести» is 45 200 in both modes.
    ["45 тысяч двести", 45_200],
    ["нужно ТО, 45 тысяч двести", 45_200],
  ])("the assistant: %s → %d", (text, km) => {
    expect(mileageInText(text)).toBe(km);
  });

  it.each([
    "пробег несколько тысяч",
    "Coolray две тысячи двадцать третьего года, нужно масло",
    "пятьдесят километров",
    "45 km",
  ])("the assistant: %s → null", (text) => {
    expect(mileageInText(text)).toBeNull();
  });

  it.each([
    ["около ста тысяч", 100_000],
    ["больше ста двадцати тысяч", 120_000],
    ["45 тысяч двести", 45_200],
    ["он пять тысяч прошёл", 5_000],
    ["он бес мың", 15_000],
    // 8. Below 100 km the field takes it, as typed by hand.
    ["пятьдесят километров", 50],
    ["45 km", 45],
    ["5", 5],
  ])("the field: %s → %d", (text, km) => {
    expect(mileageInText(text, { field: true })).toBe(km);
  });

  it.each(["несколько тысяч", "тысячи"])("the field: %s → null", (text) => {
    expect(mileageInText(text, { field: true })).toBeNull();
  });

  it.each([
    ["Geely Emgrand две тысячи пятнадцатого года", 2015],
    ["Geely две тысячи восемнадцатого", 2018],
    ["Geely две тысячи девятнадцатого", 2019],
    ["екі мың жиырма үшінші жылғы Geely", 2023],
    ["Geely 2099 Atlas 2023", 2023],
    ["Peugeot 2008 2020", 2020],
  ])("the year of %s is %d", (text, year) => {
    expect(readVehiclePhrase(text, 2026).year).toBe(year);
  });

  it("guesses no year from a number cut short", () => {
    expect(readVehiclePhrase("Geely две тысячи двухтысячного", 2026).year).toBeNull();
    expect(readVehiclePhrase("Geely Atlas 2099", 2026).year).toBeNull();
  });

  it("gives every year said, and the words with them for a model named by digits", () => {
    expect(readVehiclePhrase("Peugeot 2008 2020", 2026)).toMatchObject({
      years: [2008, 2020],
      words: ["Peugeot"],
      wordsWithYears: ["Peugeot", "2008", "2020"],
    });
    expect(vehicleYearOf([2008, 2020], "2008")).toBe(2020);
    expect(vehicleYearOf([2008], "2008")).toBeNull();
    expect(vehicleYearOf([2008, 2020], "Atlas")).toBe(2020);
    expect(vehicleYearOf([2023], null)).toBe(2023);
  });

  it("takes no engine size from a whole number with «л» or a model's number", () => {
    expect(readVehiclePhrase("Chery Tiggo 7 Pro", 2026).engineVolumeCc).toBeNull();
    expect(readVehiclePhrase("Chery Tiggo 7 л", 2026).engineVolumeCc).toBeNull();
    expect(readVehiclePhrase("Chery Tiggo 7 Pro 2022, 1.5", 2026).engineVolumeCc).toBe(1500);
    expect(readVehiclePhrase("Geely Atlas два литра", 2026).engineVolumeCc).toBe(2000);
  });
});

describe("the mileage field at the acceptance of TASK-060.A", () => {
  it.each([
    ["120к", 120_000],
    ["120k", 120_000],
    ["45200км", 45_200],
    ["пробег 120к", 120_000],
    ["пробег 45200км", 45_200],
    ["сто двадцать тысяч", 120_000],
    ["45 200", 45_200],
    ["45.200", 45_200],
  ])("%s → %d", (text, km) => {
    expect(mileageInText(text, { field: true })).toBe(km);
  });

  // A number read only in part is no reading: the person is asked again.
  it.each([
    "полтора миллиона",
    "два миллиона",
    "миллион двести тысяч",
    "сорок пять с половиной тысяч",
    "1.5",
    "пробег 1.5",
    "45,5",
    "сорок тыщ",
    "сто двадцать тысяч миль",
    "120000 miles",
  ])("%s → null", (text) => {
    expect(mileageInText(text, { field: true })).toBeNull();
  });
});
