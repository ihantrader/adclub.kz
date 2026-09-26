/**
 * The templates of messages to suppliers, as data (TASK-024 requirement 2;
 * SCREENS 8.5, ARCHITECTURE 9.1, 4.35).
 *
 * A template is not a setting (ARCHITECTURE 14): changing the text of an
 * approved WhatsApp template needs Meta's approval again (SCREENS 8.5), so
 * a text an administrator could change in the database would stop being the
 * text the provider sends. What is a setting is everything around sending —
 * attempts, pauses, the length limit.
 *
 * Every entry carries, per language: the text (`{placeholder}` where a
 * value goes) and the button titles. The real channel sends the provider's
 * template name and the values in order — the text below is ours, for the
 * test channel, for development, for the length check, and so that the
 * wording submitted to Meta lives in the repository rather than in a
 * console.
 *
 * `checkTemplateRegistry` runs at start and as a unit test: every template
 * has Kazakh and Russian, the same placeholders in every language, no
 * unknown or unused ones, and a rendering that fits the provider's limit —
 * Kazakh included, which is the language that overruns (SCREENS 9.1).
 */

/** The languages a message can be sent in (`notification_language` of an employee). */
export const MESSAGE_LANGUAGES = ["kk", "ru"] as const;
export type MessageLang = (typeof MESSAGE_LANGUAGES)[number];

/** WhatsApp's limit for the body of a template message, characters. */
export const TEMPLATE_BODY_MAX_LENGTH = 1024;

/** WhatsApp's limit for the title of a button, characters. */
export const TEMPLATE_BUTTON_TITLE_MAX_LENGTH = 25;

/**
 * How much longer than the Russian one a Kazakh text may be (SCREENS 9.1:
 * the templates are checked by length on Kazakh). Kazakh is normally
 * 15–35 % longer; well past that means a translation that grew into a
 * sentence, and it is caught here rather than after Meta approved it.
 */
export const KK_LENGTH_RATIO_MAX = 1.6;

/** A quick reply the recipient taps, or a link to the cabinet. */
export interface MessageTemplateButton {
  kind: "quick_reply" | "url";
  /** Our own name of the button; a quick reply reports it back in its payload. */
  name: string;
  titles: Record<MessageLang, string>;
}

export interface MessageTemplateDefinition {
  /** The text in SCREENS 8.5 this is (`W-08`). */
  screen: string;
  /** The name of the approved template at the provider. */
  providerName: string;
  /** Meta's category the template is approved under. */
  category: "utility" | "authentication";
  /** The placeholders, in the order the approved template has them. */
  variables: readonly string[];
  buttons: readonly MessageTemplateButton[];
  texts: Record<MessageLang, string>;
  /**
   * Values the checks render the texts with — a realistic longest case,
   * not a short one, so the length check measures what people will get.
   */
  sample: Readonly<Record<string, string>>;
  /**
   * Whether anything sends this template yet. `false` — the wording and
   * the placeholders are settled and checked, and the task that sends it is
   * named; nothing is sent by it in the meantime.
   */
  sentBy: string | null;
}

const CONFIRM: MessageTemplateButton = {
  kind: "quick_reply",
  name: "confirm",
  titles: { ru: "Подтвердить", kk: "Растау" },
};
const DECLINE: MessageTemplateButton = {
  kind: "quick_reply",
  name: "decline",
  titles: { ru: "Отказать", kk: "Бас тарту" },
};
const OPEN_CABINET: MessageTemplateButton = {
  kind: "url",
  name: "open",
  titles: { ru: "Открыть в кабинете", kk: "Кабинетте ашу" },
};
const OPEN: MessageTemplateButton = {
  kind: "url",
  name: "open",
  titles: { ru: "Открыть", kk: "Ашу" },
};

/**
 * Sample values are long on purpose: a real item name, a company name of
 * the length suppliers actually have, a cabinet address with a path.
 */
const SAMPLE = {
  number: "1042",
  item: "Колодки тормозные передние Geely 04465-0K090",
  quantity: "2",
  total: "24 500",
  fulfillment: "самовывоз",
  respondBy: "27.09 18:30",
  term: "14 марта",
  service: "Замена масла двигателя с промывкой",
  model: "Geely Atlas Pro 1.5 TD",
  date: "14 марта",
  time: "11:00",
  customerName: "Айгерим Сериккызы",
  customerPhone: "+7 701 123 45 67",
  memberName: "Айгерим",
  companyName: "Автомаркет Алматы на Райымбека",
  state: "принята: Айгерим Сериккызы, 27.09 12:40",
  added: "18",
  rejected: "3",
  text: "Просим обновить цены до конца недели: часть позиций устарела.",
  link: "https://cabinet.adclub.kz/orders/1042",
} as const;

const pick = (...names: (keyof typeof SAMPLE)[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, SAMPLE[name]]));

/**
 * The templates, keyed by what the platform calls the event. The provider
 * names are `adclub_<key>`; Meta allows lower case and underscores only.
 */
export const messageTemplates = {
  /** W-08 — the first real user of the gateway (TASK-024 requirement 5). */
  supplier_invitation: {
    screen: "W-08",
    providerName: "adclub_supplier_invitation",
    category: "utility",
    variables: ["memberName", "companyName", "link"],
    buttons: [],
    texts: {
      ru: "{memberName}, вас добавили в кабинет поставщика «{companyName}». Войти: {link}",
      kk: "{memberName}, сізді «{companyName}» жеткізушісінің кабинетіне қосты. Кіру: {link}",
    },
    sample: pick("memberName", "companyName", "link"),
    sentBy: "suppliers.send-invitation",
  },
  /** W-01 — a new order for an item in stock. */
  order_new: {
    screen: "W-01",
    providerName: "adclub_order_new",
    category: "utility",
    variables: ["number", "item", "quantity", "total", "fulfillment", "respondBy"],
    buttons: [CONFIRM, DECLINE, OPEN_CABINET],
    texts: {
      ru: "Новая заявка № {number}: {item} × {quantity}, {total} ₸, {fulfillment}. Ответьте до {respondBy}",
      kk: "№ {number} жаңа өтінім: {item} × {quantity}, {total} ₸, {fulfillment}. {respondBy} дейін жауап беріңіз",
    },
    sample: pick("number", "item", "quantity", "total", "fulfillment", "respondBy"),
    sentBy: "orders (OrderNotices.newOrder)",
  },
  /** W-01a — a new order for an item to order. */
  order_new_on_order: {
    screen: "W-01a",
    providerName: "adclub_order_new_on_order",
    category: "utility",
    variables: ["number", "item", "quantity", "term", "respondBy"],
    buttons: [
      { ...CONFIRM, titles: { ru: "Подтвердить срок", kk: "Мерзімді растау" } },
      DECLINE,
      OPEN,
    ],
    texts: {
      ru: "Заявка под заказ № {number}: {item} × {quantity}, срок до {term}. Ответьте до {respondBy}",
      kk: "№ {number} тапсырыс бойынша өтінім: {item} × {quantity}, мерзімі {term} дейін. {respondBy} дейін жауап беріңіз",
    },
    sample: pick("number", "item", "quantity", "term", "respondBy"),
    sentBy: null,
  },
  /** W-01b — a new booking of a service. */
  order_new_service: {
    screen: "W-01b",
    providerName: "adclub_order_new_service",
    category: "utility",
    variables: ["number", "service", "model", "date", "time", "respondBy"],
    buttons: [
      { ...CONFIRM, titles: { ru: "Подтвердить время", kk: "Уақытты растау" } },
      DECLINE,
      OPEN,
    ],
    texts: {
      ru: "Запись № {number}: {service}, {model}, {date} в {time}. Ответьте до {respondBy}",
      kk: "№ {number} жазылу: {service}, {model}, {date} сағат {time}. {respondBy} дейін жауап беріңіз",
    },
    sample: pick("number", "service", "model", "date", "time", "respondBy"),
    sentBy: null,
  },
  /** W-02 — after the employee confirmed: who the customer is. */
  order_accepted: {
    screen: "W-02",
    providerName: "adclub_order_accepted",
    category: "utility",
    variables: ["number", "customerName", "customerPhone", "link"],
    buttons: [],
    texts: {
      ru: "Заявка № {number} принята. Клиент: {customerName}, {customerPhone}. Отметьте готовность в кабинете: {link}",
      kk: "№ {number} өтінім қабылданды. Клиент: {customerName}, {customerPhone}. Дайындығын кабинетте белгілеңіз: {link}",
    },
    sample: pick("number", "customerName", "customerPhone", "link"),
    sentBy: "orders (OrderNotices.accepted)",
  },
  /** W-03 — the answer to a button pressed on an order that has moved on. */
  order_already_handled: {
    screen: "W-03",
    providerName: "adclub_order_already_handled",
    category: "utility",
    variables: ["number", "state"],
    buttons: [],
    texts: {
      ru: "Заявка № {number} уже {state}. Статус не изменён",
      kk: "№ {number} өтінім қазір {state}. Мәртебесі өзгермеді",
    },
    sample: pick("number", "state"),
    sentBy: "orders (OrderNotices.stateReply)",
  },
  /** W-04 — the user cancelled. */
  order_cancelled_by_user: {
    screen: "W-04",
    providerName: "adclub_order_cancelled_by_user",
    category: "utility",
    variables: ["number", "item"],
    buttons: [],
    texts: {
      ru: "Клиент отменил заявку № {number}: {item}",
      kk: "Клиент № {number} өтінімнен бас тартты: {item}",
    },
    sample: pick("number", "item"),
    sentBy: "orders (OrderNotices.cancelled)",
  },
  /** W-05 — a subscription payment did not go through. */
  payment_failed: {
    screen: "W-05",
    providerName: "adclub_payment_failed",
    category: "utility",
    variables: ["date", "link"],
    buttons: [],
    texts: {
      ru: "Не удалось списать оплату подписки. Повторим {date}. Обновите карту: {link}",
      kk: "Жазылым ақысын есептен шығара алмадық. {date} қайталаймыз. Картаңызды жаңартыңыз: {link}",
    },
    sample: pick("date", "link"),
    sentBy: null,
  },
  /** W-06 — the moderation digest, at most once a day. */
  moderation_digest: {
    screen: "W-06",
    providerName: "adclub_moderation_digest",
    category: "utility",
    variables: ["added", "rejected", "link"],
    buttons: [],
    texts: {
      ru: "Результаты проверки: добавлено {added}, отклонено {rejected}. Подробнее: {link}",
      kk: "Тексеру нәтижесі: қосылды {added}, қабылданбады {rejected}. Толығырақ: {link}",
    },
    sample: pick("added", "rejected", "link"),
    sentBy: null,
  },
  /** W-07 — a message from an administrator. */
  admin_message: {
    screen: "W-07",
    providerName: "adclub_admin_message",
    category: "utility",
    variables: ["text"],
    buttons: [],
    texts: {
      ru: "Сообщение от клуба: {text}",
      kk: "Клубтан хабарлама: {text}",
    },
    sample: pick("text"),
    sentBy: null,
  },
} as const satisfies Record<string, MessageTemplateDefinition>;

export type MessageTemplateKey = keyof typeof messageTemplates;

/** Any set of templates the checks can be run over (the registry, or a broken one in a test). */
export type MessageTemplateRegistry = Readonly<Record<string, MessageTemplateDefinition>>;

export function isMessageTemplateKey(value: string): value is MessageTemplateKey {
  return Object.hasOwn(messageTemplates, value);
}

export function messageTemplate(key: MessageTemplateKey): MessageTemplateDefinition {
  return messageTemplates[key];
}

/** `{name}` placeholders of a text, in the order they appear, without repeats. */
export function placeholdersOf(text: string): string[] {
  const found = [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]!);
  return [...new Set(found)];
}

/** A value a template placeholder may not hold, and why. */
export class MessageRenderError extends Error {
  constructor(readonly reason: "missing_variable" | "text_too_long" | "unsupported_character") {
    super(`A message could not be rendered: ${reason}`);
    this.name = "MessageRenderError";
  }
}

/**
 * A template parameter of WhatsApp may not contain a newline, a tab or
 * four spaces in a row — the provider refuses the whole message. Caught
 * here rather than as a rejection of the provider.
 */
const FORBIDDEN_IN_VARIABLE = /[\n\r\t]|\s{4}/;

/**
 * The text of one message. `maxLength` is the setting
 * `message_body_max_length`: a rendering above it is not sent at all —
 * a message cut in half is worse than one the operator is told about.
 */
export function renderMessageText(
  key: MessageTemplateKey,
  lang: MessageLang,
  variables: Readonly<Record<string, string>>,
  maxLength: number = TEMPLATE_BODY_MAX_LENGTH,
): string {
  return renderTemplate(messageTemplates[key], lang, variables, maxLength);
}

/** `renderMessageText` for any template, so the checks can render one that is not in the registry. */
export function renderTemplate(
  template: MessageTemplateDefinition,
  lang: MessageLang,
  variables: Readonly<Record<string, string>>,
  maxLength: number = TEMPLATE_BODY_MAX_LENGTH,
): string {
  for (const name of template.variables) {
    const value = variables[name];
    if (value === undefined || value.trim() === "") {
      throw new MessageRenderError("missing_variable");
    }
    if (FORBIDDEN_IN_VARIABLE.test(value)) {
      throw new MessageRenderError("unsupported_character");
    }
  }
  const text = template.texts[lang].replace(
    /\{([a-zA-Z][a-zA-Z0-9]*)\}/g,
    (_whole, name: string) => variables[name]!,
  );
  if ([...text].length > maxLength) {
    throw new MessageRenderError("text_too_long");
  }
  return text;
}

/** The values of a template's placeholders in the order the provider expects. */
export function orderedVariables(
  key: MessageTemplateKey,
  variables: Readonly<Record<string, string>>,
): string[] {
  return messageTemplates[key].variables.map((name) => {
    const value = variables[name];
    if (value === undefined || value.trim() === "") {
      throw new MessageRenderError("missing_variable");
    }
    return value;
  });
}

/**
 * Everything wrong with the registry, one line each (empty — it is sound).
 * Run at start (`MessagingModule`) and by a unit test, so a template that
 * lost its Kazakh text or gained a placeholder in one language only never
 * reaches a deployment.
 */
export function checkTemplateRegistry(
  registry: MessageTemplateRegistry = messageTemplates,
): string[] {
  const problems: string[] = [];
  const providerNames = new Map<string, string>();
  for (const [key, template] of Object.entries(registry)) {
    const taken = providerNames.get(template.providerName);
    if (taken) {
      problems.push(
        `${key}: the provider template name ${template.providerName} is already used by ${taken}`,
      );
    }
    providerNames.set(template.providerName, key);
    if (!/^adclub_[a-z0-9_]+$/.test(template.providerName)) {
      problems.push(
        `${key}: the provider template name must be adclub_<lower case and underscores>`,
      );
    }
    const declared = [...template.variables];
    if (new Set(declared).size !== declared.length) {
      problems.push(`${key}: a placeholder is declared twice`);
    }
    const lengths: Partial<Record<MessageLang, number>> = {};
    for (const lang of MESSAGE_LANGUAGES) {
      const text = template.texts[lang];
      if (!text || text.trim() === "") {
        problems.push(`${key}: no text in ${lang}`);
        continue;
      }
      const used = placeholdersOf(text);
      for (const name of used) {
        if (!declared.includes(name)) {
          problems.push(`${key} (${lang}): the text uses {${name}}, which is not declared`);
        }
      }
      for (const name of declared) {
        if (!used.includes(name)) {
          problems.push(`${key} (${lang}): the declared {${name}} is not in the text`);
        }
      }
      for (const button of template.buttons) {
        const title = button.titles[lang];
        if (!title || title.trim() === "") {
          problems.push(`${key} (${lang}): the button ${button.name} has no title`);
        } else if ([...title].length > TEMPLATE_BUTTON_TITLE_MAX_LENGTH) {
          problems.push(
            `${key} (${lang}): the title of the button ${button.name} is longer than ${String(TEMPLATE_BUTTON_TITLE_MAX_LENGTH)} characters`,
          );
        }
      }
      let rendered: string;
      try {
        rendered = renderTemplate(template, lang, template.sample);
      } catch {
        problems.push(
          `${key} (${lang}): the sample values do not render a text within ${String(TEMPLATE_BODY_MAX_LENGTH)} characters`,
        );
        continue;
      }
      lengths[lang] = [...rendered].length;
    }
    if (template.buttons.length > 3) {
      // Meta serves at most three quick replies in a template.
      problems.push(`${key}: more than three buttons`);
    }
    if (template.buttons.filter((button) => button.kind === "quick_reply").length > 3) {
      problems.push(`${key}: more than three quick replies`);
    }
    if (new Set(template.buttons.map((button) => button.name)).size !== template.buttons.length) {
      problems.push(`${key}: two buttons with the same name`);
    }
    // Kazakh is the language that overruns (SCREENS 9.1).
    if (lengths.kk !== undefined && lengths.ru !== undefined) {
      if (lengths.kk > lengths.ru * KK_LENGTH_RATIO_MAX) {
        problems.push(
          `${key}: the Kazakh text is ${(lengths.kk / lengths.ru).toFixed(2)} times the Russian one (at most ${String(KK_LENGTH_RATIO_MAX)})`,
        );
      }
    }
  }
  return problems;
}
