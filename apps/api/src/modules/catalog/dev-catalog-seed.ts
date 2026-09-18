import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CategoryIcon, CategoryKind, CreateAttributeBody } from "@adclub/contracts";
import { APP_CONFIG, type AppConfig } from "../../config";
import { CatalogAdminService, type CatalogActor } from "./catalog-admin.service";

/**
 * An example tree for development and tests (TASK-010 п. 5; PRODUCT 7.2):
 * the seven goods nodes with 2–4 subcategories each, the attributes of
 * «Моторные масла» and «Тормозные колодки», and three nodes of services.
 * Kazakh names are a first draft and need checking by a native speaker
 * (TASK-010-REPORT).
 */

interface Names {
  ru: string;
  kk: string;
  en: string;
}

interface SeedSubcategory {
  code: string;
  names: Names;
  compatibilityRequired?: boolean;
  attributes?: CreateAttributeBody[];
}

interface SeedNode {
  code: string;
  kind: CategoryKind;
  icon: CategoryIcon;
  names: Names;
  children: SeedSubcategory[];
}

const same = (text: string): Names => ({ ru: text, kk: text, en: text });

export const devCatalogTree: readonly SeedNode[] = [
  {
    code: "engine",
    kind: "goods",
    icon: "engine",
    names: { ru: "Двигатель", kk: "Қозғалтқыш", en: "Engine" },
    children: [
      {
        code: "timing_belts",
        names: { ru: "Ремни и ролики", kk: "Белдіктер мен роликтер", en: "Belts and pulleys" },
        compatibilityRequired: true,
      },
      {
        code: "spark_plugs",
        names: { ru: "Свечи зажигания", kk: "Оталдыру шамдары", en: "Spark plugs" },
        compatibilityRequired: true,
      },
      {
        code: "engine_gaskets",
        names: {
          ru: "Прокладки и сальники",
          kk: "Төсемдер мен тығыздағыштар",
          en: "Gaskets and seals",
        },
        compatibilityRequired: true,
      },
    ],
  },
  {
    code: "brakes",
    kind: "goods",
    icon: "disc",
    names: { ru: "Тормоза", kk: "Тежегіштер", en: "Brakes" },
    children: [
      {
        code: "brake_pads",
        names: { ru: "Тормозные колодки", kk: "Тежегіш қалыптары", en: "Brake pads" },
        compatibilityRequired: true,
        attributes: [
          {
            code: "axle",
            valueType: "enum",
            names: { ru: "Ось", kk: "Ось", en: "Axle" },
            isFilterable: true,
            isRequiredForComplete: true,
            options: [
              { code: "front", names: { ru: "Передняя", kk: "Алдыңғы", en: "Front" } },
              { code: "rear", names: { ru: "Задняя", kk: "Артқы", en: "Rear" } },
            ],
          },
        ],
      },
      {
        code: "brake_discs",
        names: { ru: "Тормозные диски", kk: "Тежегіш дискілері", en: "Brake discs" },
        compatibilityRequired: true,
      },
      {
        code: "brake_calipers",
        names: { ru: "Суппорты", kk: "Суппорттар", en: "Calipers" },
        compatibilityRequired: true,
      },
    ],
  },
  {
    code: "suspension",
    kind: "goods",
    icon: "car-suspension",
    names: { ru: "Подвеска", kk: "Аспа", en: "Suspension" },
    children: [
      {
        code: "shock_absorbers",
        names: { ru: "Амортизаторы", kk: "Амортизаторлар", en: "Shock absorbers" },
        compatibilityRequired: true,
      },
      {
        code: "control_arms",
        names: { ru: "Рычаги", kk: "Иінтіректер", en: "Control arms" },
        compatibilityRequired: true,
      },
      {
        code: "stabilizer_links",
        names: {
          ru: "Стойки стабилизатора",
          kk: "Тұрақтандырғыш тіректері",
          en: "Stabilizer links",
        },
        compatibilityRequired: true,
      },
    ],
  },
  {
    code: "body",
    kind: "goods",
    icon: "car-door",
    names: { ru: "Кузов", kk: "Шанақ", en: "Body" },
    children: [
      {
        code: "mirrors",
        names: { ru: "Зеркала", kk: "Айналар", en: "Mirrors" },
        compatibilityRequired: true,
      },
      {
        code: "bumpers",
        names: { ru: "Бамперы", kk: "Бамперлер", en: "Bumpers" },
        compatibilityRequired: true,
      },
      {
        // Universal (PRODUCT 7.5): shown whatever the car.
        code: "wiper_blades",
        names: {
          ru: "Щётки стеклоочистителя",
          kk: "Әйнек тазалағыш щёткалары",
          en: "Wiper blades",
        },
      },
    ],
  },
  {
    code: "electrics",
    kind: "goods",
    icon: "bolt",
    names: { ru: "Электрика", kk: "Электр жабдығы", en: "Electrics" },
    children: [
      { code: "batteries", names: { ru: "Аккумуляторы", kk: "Аккумуляторлар", en: "Batteries" } },
      { code: "bulbs", names: { ru: "Лампы", kk: "Шамдар", en: "Bulbs" } },
      { code: "fuses", names: { ru: "Предохранители", kk: "Сақтандырғыштар", en: "Fuses" } },
    ],
  },
  {
    code: "interior",
    kind: "goods",
    icon: "armchair",
    names: { ru: "Салон", kk: "Салон", en: "Interior" },
    children: [
      { code: "floor_mats", names: { ru: "Коврики", kk: "Кілемшелер", en: "Floor mats" } },
      { code: "seat_covers", names: { ru: "Чехлы", kk: "Қаптар", en: "Seat covers" } },
      {
        code: "accessories",
        names: { ru: "Аксессуары", kk: "Аксессуарлар", en: "Accessories" },
      },
    ],
  },
  {
    code: "consumables",
    kind: "goods",
    icon: "droplet",
    names: { ru: "Расходники", kk: "Шығын материалдары", en: "Consumables" },
    children: [
      {
        code: "engine_oils",
        names: { ru: "Моторные масла", kk: "Мотор майлары", en: "Engine oils" },
        attributes: [
          {
            code: "viscosity",
            valueType: "enum",
            names: { ru: "Вязкость", kk: "Тұтқырлық", en: "Viscosity" },
            isFilterable: true,
            isRequiredForComplete: true,
            options: [
              { code: "0w_20", names: same("0W-20") },
              { code: "5w_30", names: same("5W-30") },
              { code: "5w_40", names: same("5W-40") },
              { code: "10w_40", names: same("10W-40") },
            ],
          },
          {
            code: "approval",
            valueType: "enum",
            names: { ru: "Допуск", kk: "Рұқсат", en: "Approval" },
            isFilterable: true,
            isRequiredForComplete: false,
            options: [
              { code: "api_sn", names: same("API SN") },
              { code: "api_sp", names: same("API SP") },
              { code: "acea_c3", names: same("ACEA C3") },
              { code: "acea_a3_b4", names: same("ACEA A3/B4") },
            ],
          },
          {
            code: "volume",
            valueType: "number",
            names: { ru: "Объём", kk: "Көлемі", en: "Volume" },
            unit: { ru: "л", kk: "л", en: "L" },
            number: { integer: false, min: 0.1, max: 220 },
            isFilterable: true,
            isRequiredForComplete: true,
          },
        ],
      },
      {
        code: "oil_filters",
        names: { ru: "Масляные фильтры", kk: "Май сүзгілері", en: "Oil filters" },
        compatibilityRequired: true,
      },
      {
        code: "air_filters",
        names: { ru: "Воздушные фильтры", kk: "Ауа сүзгілері", en: "Air filters" },
        compatibilityRequired: true,
      },
      {
        code: "cabin_filters",
        names: { ru: "Салонные фильтры", kk: "Салон сүзгілері", en: "Cabin filters" },
        compatibilityRequired: true,
      },
    ],
  },
  {
    code: "maintenance",
    kind: "services",
    icon: "tool",
    names: { ru: "Техобслуживание", kk: "Техникалық қызмет", en: "Maintenance" },
    children: [
      { code: "oil_change", names: { ru: "Замена масла", kk: "Май ауыстыру", en: "Oil change" } },
      {
        code: "brake_pad_replacement",
        names: {
          ru: "Замена тормозных колодок",
          kk: "Тежегіш қалыптарын ауыстыру",
          en: "Brake pad replacement",
        },
      },
    ],
  },
  {
    code: "diagnostics",
    kind: "services",
    icon: "gauge",
    names: { ru: "Диагностика", kk: "Диагностика", en: "Diagnostics" },
    children: [
      {
        code: "computer_diagnostics",
        names: {
          ru: "Компьютерная диагностика",
          kk: "Компьютерлік диагностика",
          en: "Computer diagnostics",
        },
      },
    ],
  },
  {
    code: "tire_service",
    kind: "services",
    icon: "wheel",
    names: { ru: "Шиномонтаж", kk: "Шина жөндеу", en: "Tire service" },
    children: [
      {
        code: "seasonal_tire_change",
        names: {
          ru: "Сезонная замена шин",
          kk: "Шиналарды маусымдық ауыстыру",
          en: "Seasonal tire change",
        },
      },
      {
        code: "wheel_balancing",
        names: { ru: "Балансировка колёс", kk: "Дөңгелек теңгерімі", en: "Wheel balancing" },
      },
    ],
  },
];

export interface DevCatalogSeedResult {
  created: { categories: number; attributes: number; options: number };
  existing: { categories: number; attributes: number; options: number };
}

export class DevCatalogSeedError extends Error {}

const OPERATOR: CatalogActor = { role: "operator" };

/**
 * Fills the catalog with `devCatalogTree` through the same service the
 * administrator uses (every check applies; every creation is in the
 * action journal by the operator). Idempotent: what already exists by its
 * code is left as it is, so a second run creates nothing.
 */
@Injectable()
export class DevCatalogSeed {
  private readonly logger = new Logger("Catalog");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CatalogAdminService) private readonly catalog: CatalogAdminService,
  ) {}

  async run(): Promise<DevCatalogSeedResult> {
    if (this.config.nodeEnv !== "development" && this.config.nodeEnv !== "test") {
      throw new DevCatalogSeedError(
        "The catalog is kept by the administrator; the example tree is for development and tests only",
      );
    }
    const result: DevCatalogSeedResult = {
      created: { categories: 0, attributes: 0, options: 0 },
      existing: { categories: 0, attributes: 0, options: 0 },
    };
    for (const node of devCatalogTree) {
      const nodeId = await this.category(result, {
        code: node.code,
        kind: node.kind,
        names: node.names,
        icon: node.icon,
      });
      for (const child of node.children) {
        const childId = await this.category(result, {
          code: child.code,
          kind: node.kind,
          parentId: nodeId,
          names: child.names,
          compatibilityRequired: child.compatibilityRequired ?? false,
        });
        for (const spec of child.attributes ?? []) {
          await this.attribute(result, childId, spec);
        }
      }
    }
    this.logger.log(
      `Development catalog seeded created=${JSON.stringify(result.created)} existing=${JSON.stringify(result.existing)}`,
    );
    return result;
  }

  private async category(
    result: DevCatalogSeedResult,
    input: Parameters<CatalogAdminService["createCategory"]>[0],
  ): Promise<string> {
    const existing = await this.catalog.findCategoryByCode(input.code);
    if (existing) {
      result.existing.categories += 1;
      return existing.id;
    }
    result.created.categories += 1;
    return (await this.catalog.createCategory(input, OPERATOR)).id;
  }

  private async attribute(
    result: DevCatalogSeedResult,
    categoryId: string,
    spec: CreateAttributeBody,
  ): Promise<void> {
    const existing = await this.catalog.findAttributeByCode(categoryId, spec.code);
    if (!existing) {
      const created = await this.catalog.createAttribute(categoryId, spec, OPERATOR);
      result.created.attributes += 1;
      result.created.options += created.options.length;
      return;
    }
    result.existing.attributes += 1;
    for (const option of spec.options ?? []) {
      if (await this.catalog.findOptionByCode(existing.id, option.code)) {
        result.existing.options += 1;
      } else {
        await this.catalog.createOption(existing.id, option, OPERATOR);
        result.created.options += 1;
      }
    }
  }
}
