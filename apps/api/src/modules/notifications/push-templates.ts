import type { NotificationKind } from "@adclub/contracts";

/**
 * The texts of push notifications to the user (SCREENS 8.4; TASK-051) — data
 * of the code, like the WhatsApp templates (4.35): kk, ru and en, with
 * `{placeholders}` the event fills in. There is no title: the system shows
 * the app's name above the text.
 *
 * The registry is checked when the process starts and by `pnpm test`
 * (`checkPushTemplates`): every language, the same placeholders in each, and a
 * length a lock screen can show.
 *
 * Templates without an ID of SCREENS (`P-ORD-02a`, `P-ORD-10`) are ours, in
 * the spirit of their neighbours, and wait for the Product Owner's approval
 * (TASK-051 report). **The Kazakh is a working draft** — a native speaker
 * checks it, as with the WhatsApp templates.
 */

export const PUSH_LANGUAGES = ["kk", "ru", "en"] as const;
export type PushLang = (typeof PUSH_LANGUAGES)[number];

export interface PushTemplateDefinition {
  /** The id of SCREENS 8.4 (or ours, waiting for approval). */
  screen: string;
  kind: NotificationKind;
  texts: Readonly<Record<PushLang, string>>;
}

/** The longest text with its values: what a lock screen shows in a few lines. */
export const PUSH_BODY_MAX_LENGTH = 240;

export const pushTemplates = {
  order_accepted: {
    screen: "P-ORD-01",
    kind: "order_accepted",
    texts: {
      ru: "{supplier} принял заявку: {item}",
      kk: "{supplier} өтінімді қабылдады: {item}",
      en: "{supplier} accepted your order: {item}",
    },
  },
  order_ready: {
    screen: "P-ORD-02",
    kind: "order_ready",
    texts: {
      ru: "Можно забирать: {item}. Резерв до {until}",
      kk: "Алып кетуге болады: {item}. Резерв {until} дейін",
      en: "Ready for pickup: {item}. Reserved until {until}",
    },
  },
  // An order delivered by the supplier has no reserve to name (ours, for approval).
  order_ready_delivery: {
    screen: "P-ORD-02a",
    kind: "order_ready",
    texts: {
      ru: "Заказ готов: {item}",
      kk: "Тапсырыс дайын: {item}",
      en: "Your order is ready: {item}",
    },
  },
  reserve_expiring: {
    screen: "P-ORD-03",
    kind: "reserve_expiring",
    texts: {
      ru: "Резерв заканчивается в {time}: {item}",
      kk: "Резерв сағат {time} аяқталады: {item}",
      en: "Your reservation ends at {time}: {item}",
    },
  },
  order_declined: {
    screen: "P-ORD-04",
    kind: "order_declined",
    texts: {
      ru: "Поставщик отказал по заявке: {item}. Посмотрите другие предложения",
      kk: "Жеткізуші өтінім бойынша бас тартты: {item}. Басқа ұсыныстарды қараңыз",
      en: "The supplier declined your order: {item}. See other offers",
    },
  },
  term_proposed: {
    screen: "P-ORD-05",
    kind: "term_proposed",
    texts: {
      ru: "Поставщик предлагает срок до {date}. Ответьте до {answerBy}",
      kk: "Жеткізуші {date} дейінгі мерзімді ұсынады. {answerBy} дейін жауап беріңіз",
      en: "The supplier proposes a term until {date}. Reply by {answerBy}",
    },
  },
  time_proposed: {
    screen: "P-ORD-05",
    kind: "time_proposed",
    texts: {
      ru: "Поставщик предлагает {date} в {time}. Ответьте до {answerBy}",
      kk: "Жеткізуші {date}, сағат {time} уақытын ұсынады. {answerBy} дейін жауап беріңіз",
      en: "The supplier proposes {date} at {time}. Reply by {answerBy}",
    },
  },
  order_closed: {
    screen: "P-ORD-06",
    kind: "order_closed",
    texts: {
      ru: "Заявка закрыта: {item}. Не получали? Сообщите нам",
      kk: "Өтінім жабылды: {item}. Алмадыңыз ба? Бізге хабарлаңыз",
      en: "Order closed: {item}. Didn't receive it? Let us know",
    },
  },
  order_expired_no_response: {
    screen: "P-ORD-07",
    kind: "order_expired_no_response",
    texts: {
      ru: "Поставщик не ответил вовремя — заявка отменена. Посмотрите другие предложения",
      kk: "Жеткізуші уақытында жауап бермеді — өтінім тоқтатылды. Басқа ұсыныстарды қараңыз",
      en: "The supplier didn't reply in time — the order is cancelled. See other offers",
    },
  },
  term_confirmed: {
    screen: "P-ORD-08",
    kind: "order_confirmed",
    texts: {
      ru: "Поставщик подтвердил срок: до {date}",
      kk: "Жеткізуші мерзімді растады: {date} дейін",
      en: "The supplier confirmed the term: by {date}",
    },
  },
  time_confirmed: {
    screen: "P-ORD-09",
    kind: "order_confirmed",
    texts: {
      ru: "Ждём вас {date} в {time}, {supplier}",
      kk: "Сізді {date}, сағат {time} күтеміз, {supplier}",
      en: "We expect you on {date} at {time}, {supplier}",
    },
  },
  // ARCHITECTURE 4.59 promised it to this task; SCREENS 8.4 has no text (ours, for approval).
  supply_overdue: {
    screen: "P-ORD-10",
    kind: "supply_overdue",
    texts: {
      ru: "Срок поставки прошёл: {item}. Свяжитесь с поставщиком",
      kk: "Жеткізу мерзімі өтті: {item}. Жеткізушімен байланысыңыз",
      en: "The delivery term has passed: {item}. Contact the supplier",
    },
  },
  review_text_rejected: {
    screen: "P-REV-01",
    kind: "review_text_rejected",
    texts: {
      ru: "Отзыв не опубликован: {reason}. Можно исправить",
      kk: "Пікір жарияланбады: {reason}. Түзетуге болады",
      en: "Review not published: {reason}. You can correct it",
    },
  },
  payment_failed: {
    screen: "P-SUB-01",
    kind: "payment_failed",
    texts: {
      ru: "Не удалось оплатить подписку. Обновите способ оплаты, чтобы сохранить доступ",
      kk: "Жазылымды төлеу мүмкін болмады. Қолжетімділікті сақтау үшін төлем тәсілін жаңартыңыз",
      en: "We couldn't charge your subscription. Update your payment method to keep access",
    },
  },
} as const satisfies Record<string, PushTemplateDefinition>;

export type PushTemplateCode = keyof typeof pushTemplates;

/** «Поставщик» — what the text says instead of the name to a person without club access (SCREENS 8.4). */
export const SUPPLIER_WORD: Readonly<Record<PushLang, string>> = {
  ru: "Поставщик",
  kk: "Жеткізуші",
  en: "The supplier",
};

export function isPushTemplateCode(value: string): value is PushTemplateCode {
  return Object.hasOwn(pushTemplates, value);
}

export function pushTemplate(code: PushTemplateCode): PushTemplateDefinition {
  return pushTemplates[code];
}

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort();
}

export class PushRenderError extends Error {
  constructor(readonly reason: string) {
    super(`The push cannot be rendered: ${reason}`);
    this.name = "PushRenderError";
  }
}

/** One line, no runs of spaces, no control characters. */
function oneLine(value: string): string {
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The text of a push with its values. Every placeholder of the template needs
 * a value and no other value is taken: a template used wrongly fails where
 * the mistake is, when it is queued.
 */
export function renderPushText(
  code: PushTemplateCode,
  lang: PushLang,
  variables: Readonly<Record<string, string>>,
): string {
  const text = pushTemplates[code].texts[lang];
  const wanted = placeholdersOf(text);
  const given = Object.keys(variables).sort();
  const missing = wanted.filter((name) => !given.includes(name));
  const unknown = given.filter((name) => !wanted.includes(name));
  if (missing.length > 0 || unknown.length > 0) {
    throw new PushRenderError(
      `${code}: missing [${missing.join(", ")}], unknown [${unknown.join(", ")}]`,
    );
  }
  const body = text.replace(PLACEHOLDER, (_, name: string) => oneLine(variables[name] ?? ""));
  if ([...body].length > PUSH_BODY_MAX_LENGTH) {
    throw new PushRenderError(`${code}: longer than ${String(PUSH_BODY_MAX_LENGTH)} characters`);
  }
  return body;
}

/** What is wrong with the registry; empty — nothing. */
export function checkPushTemplates(): string[] {
  const problems: string[] = [];
  for (const [code, template] of Object.entries(pushTemplates) as [
    PushTemplateCode,
    PushTemplateDefinition,
  ][]) {
    const reference = placeholdersOf(template.texts.ru).join(",");
    for (const lang of PUSH_LANGUAGES) {
      const text = template.texts[lang];
      if (!text || text.trim() === "") {
        problems.push(`${code}: no ${lang} text`);
        continue;
      }
      if (placeholdersOf(text).join(",") !== reference) {
        problems.push(`${code}: the placeholders of ${lang} differ from ru`);
      }
      // The text alone leaves room for its values.
      if ([...text].length > PUSH_BODY_MAX_LENGTH / 2) {
        problems.push(`${code}: the ${lang} text is too long for a push`);
      }
    }
  }
  return problems;
}

/** The language of a person's push: their account's, Russian without one. */
export function pushLangOf(language: string | null | undefined): PushLang {
  return language === "kk" || language === "en" ? language : "ru";
}
