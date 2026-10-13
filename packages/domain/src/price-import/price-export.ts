import type { PriceColumnRole } from "./column-headers";

/**
 * «Скачать мой прайс» (TASK-048; ARCHITECTURE 12.4): what the cabinet's own
 * export of the company's offers holds — the columns, their headers in the
 * language of the employee, and the cells of one offer. The file comes back
 * as a price list: the hidden `item_id` column matches each row by itself,
 * and the words of the cells are the ones `readPriceRow` reads back to the
 * same values, so a file returned without changes changes nothing.
 */

type ExportLang = "kk" | "ru" | "en";

export const PRICE_EXPORT_COLUMNS = [
  "item_id",
  "article",
  "brand",
  "name",
  "price",
  "availability",
  "lead_days",
  "pickup",
  "delivery",
  "warranty",
] as const;

type ExportColumn = (typeof PRICE_EXPORT_COLUMNS)[number];

const HEADERS: Record<ExportLang, Record<ExportColumn, string>> = {
  ru: {
    item_id: "item_id",
    article: "Артикул",
    brand: "Бренд",
    name: "Название",
    price: "Цена, ₸",
    availability: "Наличие",
    lead_days: "Срок, дн.",
    pickup: "Самовывоз",
    delivery: "Доставка",
    warranty: "Гарантия",
  },
  kk: {
    item_id: "item_id",
    article: "Артикул",
    brand: "Бренд",
    name: "Атауы",
    price: "Бағасы, ₸",
    availability: "Қоймада",
    lead_days: "Мерзімі, күн",
    pickup: "Өзі алып кету",
    delivery: "Жеткізу",
    warranty: "Кепілдік",
  },
  en: {
    item_id: "item_id",
    article: "Article",
    brand: "Brand",
    name: "Name",
    price: "Price, ₸",
    availability: "Availability",
    lead_days: "Lead time, days",
    pickup: "Pickup",
    delivery: "Delivery",
    warranty: "Warranty",
  },
};

/** Words of the cells, each one read back by `readAvailability` to the same value. */
const WORDS: Record<
  ExportLang,
  {
    in_stock: string;
    on_order: string;
    out_of_stock: string;
    yes: string;
    no: string;
    months: string;
  }
> = {
  ru: {
    in_stock: "В наличии",
    on_order: "Под заказ",
    out_of_stock: "Нет в наличии",
    yes: "Да",
    no: "Нет",
    months: "мес.",
  },
  kk: {
    in_stock: "Қоймада бар",
    on_order: "Тапсырыспен",
    out_of_stock: "Жоқ",
    yes: "Иә",
    no: "Жоқ",
    months: "ай",
  },
  en: {
    in_stock: "In stock",
    on_order: "On order",
    out_of_stock: "Out of stock",
    yes: "Yes",
    no: "No",
    months: "mo.",
  },
};

const HINTS: Record<ExportLang, { title: string; sheet: string; lines: string[]; empty: string }> =
  {
    ru: {
      title: "Прайс",
      sheet: "Подсказка",
      lines: [
        "Это ваши предложения из кабинета поставщика.",
        "Меняйте цену, наличие и срок и загрузите файл обратно в разделе «Прайс».",
        "Первую колонку (item_id, она скрыта) не меняйте и не удаляйте: по ней строки узнаются сразу, без проверки.",
        "Самовывоз, доставка и гарантия из файла не загружаются — они меняются в самом предложении.",
        "Новые строки можно добавить внизу: их сопоставят со справочником, как строки обычного прайса.",
      ],
      empty:
        "Предложений пока нет. Впишите товары в лист «Прайс» под заголовком и загрузите файл в разделе «Прайс».",
    },
    kk: {
      title: "Прайс",
      sheet: "Нұсқау",
      lines: [
        "Бұл — жеткізуші кабинетіндегі сіздің ұсыныстарыңыз.",
        "Бағаны, қоймадағы барын және мерзімді өзгертіп, файлды «Прайс» бөліміне қайта жүктеңіз.",
        "Бірінші бағанды (item_id, ол жасырын) өзгертпеңіз және жоймаңыз: жолдар сол арқылы бірден танылады.",
        "Өзі алып кету, жеткізу және кепілдік файлдан жүктелмейді — олар ұсыныстың өзінде өзгертіледі.",
        "Жаңа жолдарды төменге қосуға болады: олар әдеттегі прайс жолдары сияқты анықтамалықпен салыстырылады.",
      ],
      empty:
        "Әзірге ұсыныстар жоқ. Тауарларды «Прайс» парағына тақырыптың астына жазып, файлды «Прайс» бөліміне жүктеңіз.",
    },
    en: {
      title: "Price list",
      sheet: "How to",
      lines: [
        "These are your offers from the supplier cabinet.",
        "Change prices, availability and lead times, then upload the file back in «Price list».",
        "Don't change or delete the first column (item_id, it is hidden): it lets each row be recognised at once.",
        "Pickup, delivery and warranty are not read from the file — change them in the offer itself.",
        "You may add new rows at the bottom: they are matched with the catalog like a usual price list.",
      ],
      empty:
        "No offers yet. Write your goods into the «Price list» sheet under the header and upload the file in «Price list».",
    },
  };

/** The names of the two sheets and the lines of the second one, «Подсказка». */
export function priceExportHint(
  lang: ExportLang,
  empty: boolean,
): { title: string; sheet: string; lines: string[] } {
  const hint = HINTS[lang];
  return {
    title: hint.title,
    sheet: hint.sheet,
    lines: empty ? [hint.empty, ...hint.lines.slice(1)] : hint.lines,
  };
}

/** The header row of the export in the employee's language. */
export function priceExportHeader(lang: ExportLang): string[] {
  return PRICE_EXPORT_COLUMNS.map((column) => HEADERS[lang][column]);
}

/**
 * The roles of the export's columns, as the company's remembered format: a
 * file coming back skips the screen of columns. Pickup, delivery and the
 * warranty are shown, not read back — they are set in the offer itself.
 */
export function priceExportRoles(): PriceColumnRole[] {
  return PRICE_EXPORT_COLUMNS.map((column) => {
    switch (column) {
      case "pickup":
      case "delivery":
      case "warranty":
        return "ignore";
      default:
        return column;
    }
  });
}

/** An offer of the company as the export needs it. */
export interface PriceExportOffer {
  itemId: string;
  /** The company's own article; `null` — the catalog's is shown. */
  supplierSku: string | null;
  catalogArticle: string | null;
  brand: string | null;
  /** The company's own name of the item; `null` — the catalog's is shown. */
  supplierName: string | null;
  catalogName: string;
  price: number;
  availability: "in_stock" | "on_order";
  leadDays: number;
  /** A withdrawn offer is «нет в наличии»: returned as it is, it stays withdrawn. */
  status: "active" | "withdrawn" | "suspended";
  pickup: boolean;
  delivery: boolean;
  warrantyMonths: number | null;
  warrantyText: string | null;
}

/** The cells of one offer, in the order of `PRICE_EXPORT_COLUMNS`. */
export function priceExportRow(
  offer: PriceExportOffer,
  lang: ExportLang,
): (string | number | null)[] {
  const words = WORDS[lang];
  const availability =
    offer.status === "withdrawn" ? words.out_of_stock : words[offer.availability];
  const warranty =
    offer.warrantyText ??
    (offer.warrantyMonths !== null ? `${String(offer.warrantyMonths)} ${words.months}` : null);
  return [
    offer.itemId,
    offer.supplierSku ?? offer.catalogArticle,
    offer.brand,
    offer.supplierName ?? offer.catalogName,
    offer.price,
    availability,
    offer.leadDays,
    offer.pickup ? words.yes : words.no,
    offer.delivery ? words.yes : words.no,
    warranty,
  ];
}
