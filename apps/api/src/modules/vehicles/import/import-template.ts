import {
  vehicleImportColumns,
  vehicleImportRequiredColumns,
  type VehicleImportColumn,
  type VehicleImportTemplateColumn,
} from "@adclub/contracts";

/**
 * The import file template (A-CAR-02 «Скачать шаблон»): the columns in
 * their order with what goes there and an example row. The descriptions
 * are for the administrator, so they are in Russian.
 */
const COLUMNS: Record<VehicleImportColumn, { description: string; example: string }> = {
  make: {
    description:
      "Марка. Сравнивается с названием и другими написаниями без учёта регистра и пробелов («GEELY» = «Geely»). Новая марка будет создана — она видна в отчёте до применения.",
    example: "Geely",
  },
  model: {
    description: "Модель марки (так же по написаниям). Новая модель будет создана.",
    example: "Coolray",
  },
  generation: {
    description:
      "Поколение модели по названию (без учёта регистра). Если его нет, нужны годы поколения — иначе строка отклоняется.",
    example: "I (SX11)",
  },
  generation_year_from: {
    description:
      "Первый год поколения. Нужен, только чтобы создать новое поколение; у существующего должен совпадать с годами в справочнике.",
    example: "2019",
  },
  generation_year_to: {
    description: "Последний год поколения; пусто — выпускается сейчас.",
    example: "",
  },
  body: {
    description: "Кузов: код или название из справочного списка на любом языке.",
    example: "crossover",
  },
  engine_code: {
    description:
      "Код двигателя (или другое его написание). Новый двигатель будет создан — для него нужно топливо.",
    example: "JLH-3G15TD",
  },
  engine_displacement_l: {
    description:
      "Объём, л (1.5 или 1,5); пусто — не указан. У существующего двигателя должен совпадать.",
    example: "1.5",
  },
  engine_fuel: {
    description:
      "Топливо: код или название из справочного списка. Обязательно для нового двигателя.",
    example: "petrol",
  },
  engine_power_hp: {
    description: "Мощность, л. с.; пусто — не указана. У существующего двигателя должна совпадать.",
    example: "177",
  },
  transmission: {
    description: "КПП: код или название из справочного списка.",
    example: "dct",
  },
  drive: {
    description: "Привод: код или название из справочного списка.",
    example: "fwd",
  },
  year_from: {
    description: "Первый год модификации — в пределах лет поколения.",
    example: "2020",
  },
  year_to: {
    description: "Последний год модификации; пусто — выпускается сейчас (если поколение тоже).",
    example: "",
  },
  market: {
    description:
      "Рынок: kz — казахстанская комплектация, global — общая. Совпавшая модификация с другим рынком будет обновлена.",
    example: "kz",
  },
};

export const IMPORT_TEMPLATE_FILE_NAME = "vehicles-import-template.csv";
export const IMPORT_TEMPLATE_DELIMITER = ",";

const REQUIRED = new Set<string>(vehicleImportRequiredColumns);

export function templateColumns(): VehicleImportTemplateColumn[] {
  return vehicleImportColumns.map((name) => ({
    name,
    required: REQUIRED.has(name),
    description: COLUMNS[name].description,
    example: COLUMNS[name].example,
  }));
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The header and the example row, as a file the importer takes back as it is. */
export function templateCsv(): string {
  const header = vehicleImportColumns.join(IMPORT_TEMPLATE_DELIMITER);
  const example = vehicleImportColumns
    .map((name) => csvCell(COLUMNS[name].example))
    .join(IMPORT_TEMPLATE_DELIMITER);
  return `${header}\r\n${example}\r\n`;
}
