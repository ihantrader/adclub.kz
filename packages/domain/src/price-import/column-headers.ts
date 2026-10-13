/**
 * How suppliers title the columns of a price list (TASK-046; ARCHITECTURE
 * 12.1 step 3, 4.66) — data, not code: a new spelling is a new line here,
 * and the cabinet's screen knows nothing of it. Russian, Kazakh and English
 * spellings side by side; a header is compared after `normalizeHeader`
 * (lower case, «ё» as «е», punctuation as spaces), so «Цена, тг.» and
 * «цена тг» are one spelling.
 *
 * `weight` says how sure a spelling is of its role: «Цена» and «Розница» are
 * the price for certain, «Опт» only perhaps (a club price is not the
 * wholesale one), «Код» is an article in most lists but the internal code
 * of 1C in others. The longest spelling found in a header decides it, so
 * «Цена опт» is the wholesale price and not «Цена».
 */

export const priceColumnRoles = [
  "article",
  "brand",
  "name",
  "price",
  "availability",
  "lead_days",
  /**
   * The hidden column of the cabinet's own export, «Скачать мой прайс»
   * (TASK-048; ARCHITECTURE 12.4): the catalog item of the company's offer.
   * A row that has it is matched by it alone — no search, no AI.
   */
  "item_id",
  "ignore",
] as const;

export type PriceColumnRole = (typeof priceColumnRoles)[number];

/** The roles a column can be given except «Не использовать». */
export type PriceDataRole = Exclude<PriceColumnRole, "ignore">;

export interface PriceHeaderSpelling {
  text: string;
  weight: number;
}

export const priceHeaderSpellings: Readonly<Record<PriceDataRole, readonly PriceHeaderSpelling[]>> =
  {
    article: [
      { text: "артикул", weight: 1 },
      { text: "арт", weight: 0.9 },
      { text: "артикул производителя", weight: 1 },
      { text: "артикул поставщика", weight: 1 },
      { text: "каталожный номер", weight: 1 },
      { text: "кат номер", weight: 0.9 },
      { text: "номер детали", weight: 1 },
      { text: "номер запчасти", weight: 1 },
      { text: "оригинальный номер", weight: 1 },
      { text: "oem", weight: 0.9 },
      { text: "oem номер", weight: 1 },
      { text: "код", weight: 0.6 },
      { text: "код товара", weight: 0.7 },
      { text: "part no", weight: 1 },
      { text: "part number", weight: 1 },
      { text: "partnumber", weight: 1 },
      { text: "part", weight: 0.7 },
      { text: "article", weight: 1 },
      { text: "art", weight: 0.8 },
      { text: "sku", weight: 0.9 },
      { text: "code", weight: 0.6 },
      { text: "catalog number", weight: 1 },
      { text: "mpn", weight: 0.9 },
      { text: "тауар коды", weight: 0.7 },
      { text: "коды", weight: 0.6 },
      { text: "каталог нөмірі", weight: 1 },
      { text: "бөлшек нөмірі", weight: 1 },
      { text: "бөлшек коды", weight: 0.9 },
    ],
    brand: [
      { text: "бренд", weight: 1 },
      { text: "производитель", weight: 1 },
      { text: "изготовитель", weight: 1 },
      { text: "марка", weight: 0.8 },
      { text: "фирма", weight: 0.8 },
      { text: "торговая марка", weight: 1 },
      { text: "brand", weight: 1 },
      { text: "manufacturer", weight: 1 },
      { text: "maker", weight: 0.9 },
      { text: "make", weight: 0.8 },
      { text: "vendor", weight: 0.8 },
      { text: "өндіруші", weight: 1 },
      { text: "өндірушісі", weight: 1 },
      { text: "маркасы", weight: 0.8 },
    ],
    name: [
      { text: "наименование", weight: 1 },
      { text: "наименование товара", weight: 1 },
      { text: "номенклатура", weight: 1 },
      { text: "название", weight: 1 },
      { text: "наим", weight: 0.9 },
      { text: "товар", weight: 0.8 },
      { text: "описание", weight: 0.8 },
      { text: "name", weight: 1 },
      { text: "product name", weight: 1 },
      { text: "product", weight: 0.8 },
      { text: "description", weight: 0.8 },
      { text: "item", weight: 0.7 },
      { text: "title", weight: 0.8 },
      { text: "атауы", weight: 1 },
      { text: "атау", weight: 1 },
      { text: "тауар атауы", weight: 1 },
      { text: "тауар", weight: 0.8 },
      { text: "сипаттамасы", weight: 0.8 },
    ],
    price: [
      { text: "цена", weight: 1 },
      { text: "розница", weight: 1 },
      { text: "розничная цена", weight: 1 },
      { text: "цена розница", weight: 1 },
      { text: "цена розн", weight: 1 },
      { text: "стоимость", weight: 0.9 },
      { text: "опт", weight: 0.5 },
      { text: "оптовая цена", weight: 0.5 },
      { text: "цена опт", weight: 0.5 },
      { text: "закупочная цена", weight: 0.3 },
      { text: "price", weight: 1 },
      { text: "retail price", weight: 1 },
      { text: "retail", weight: 1 },
      { text: "cost", weight: 0.7 },
      { text: "wholesale", weight: 0.5 },
      { text: "wholesale price", weight: 0.5 },
      { text: "бағасы", weight: 1 },
      { text: "баға", weight: 1 },
      { text: "бөлшек баға", weight: 1 },
      { text: "бөлшек сауда бағасы", weight: 1 },
      { text: "құны", weight: 0.9 },
      { text: "көтерме баға", weight: 0.5 },
      { text: "көтерме", weight: 0.5 },
    ],
    availability: [
      { text: "наличие", weight: 1 },
      { text: "в наличии", weight: 1 },
      { text: "остаток", weight: 1 },
      { text: "остатки", weight: 1 },
      { text: "кол во", weight: 0.9 },
      { text: "количество", weight: 0.9 },
      { text: "склад", weight: 0.8 },
      { text: "на складе", weight: 1 },
      { text: "qty", weight: 0.9 },
      { text: "quantity", weight: 0.9 },
      { text: "stock", weight: 1 },
      { text: "in stock", weight: 1 },
      { text: "availability", weight: 1 },
      { text: "бар болуы", weight: 1 },
      { text: "қалдық", weight: 1 },
      { text: "саны", weight: 0.9 },
      { text: "қойма", weight: 0.8 },
      { text: "қоймада", weight: 1 },
    ],
    lead_days: [
      { text: "срок", weight: 0.9 },
      { text: "срок поставки", weight: 1 },
      { text: "срок доставки", weight: 1 },
      { text: "срок поставки дн", weight: 1 },
      { text: "срок дн", weight: 1 },
      { text: "дней", weight: 0.7 },
      { text: "поставка", weight: 0.7 },
      { text: "lead time", weight: 1 },
      { text: "delivery time", weight: 1 },
      { text: "delivery days", weight: 1 },
      { text: "days", weight: 0.7 },
      { text: "мерзімі", weight: 0.9 },
      { text: "жеткізу мерзімі", weight: 1 },
      { text: "күн", weight: 0.7 },
    ],
    // Only the cabinet's export names a column so (TASK-048).
    item_id: [{ text: "item_id", weight: 1 }],
  };

/**
 * Words that make any price column a doubtful one: a header with one of
 * them is at most `weight` 0.5, whatever else it says («Цена оптовая»).
 */
export const priceDoubtWords: readonly string[] = [
  "опт",
  "оптовая",
  "оптовый",
  "закуп",
  "закупочная",
  "себестоимость",
  "wholesale",
  "purchase",
  "көтерме",
];

/**
 * Units of measure: a column of «шт», «компл», «л» is the unit of a 1C export,
 * not a brand, whatever its cells look like.
 */
export const priceUnitWords: readonly string[] = [
  "шт",
  "штук",
  "ед",
  "компл",
  "комплект",
  "кмп",
  "пара",
  "пар",
  "л",
  "литр",
  "кг",
  "м",
  "упак",
  "уп",
  "набор",
  "pcs",
  "pc",
  "set",
  "дана",
  "жиынтық",
];

/** The first cell of a row of totals, not of goods. */
export const priceTotalWords: readonly string[] = [
  "итого",
  "всего",
  "total",
  "subtotal",
  "барлығы",
  "жиыны",
  "жалпы",
];
