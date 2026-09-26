import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkTemplateRegistry,
  isMessageTemplateKey,
  KK_LENGTH_RATIO_MAX,
  MESSAGE_LANGUAGES,
  messageTemplates,
  MessageRenderError,
  orderedVariables,
  placeholdersOf,
  renderMessageText,
  TEMPLATE_BODY_MAX_LENGTH,
  TEMPLATE_BUTTON_TITLE_MAX_LENGTH,
  type MessageTemplateDefinition,
  type MessageTemplateRegistry,
} from "./message-templates";

/** The identifiers of the templates in SCREENS 8.5 (`W-01`, `W-01a`, …). */
function screensTemplateIds(): string[] {
  const screens = readFileSync(join(__dirname, "../../../../../SCREENS.md"), "utf8");
  const section = screens.slice(
    screens.indexOf("### 8.5 Кабинет поставщика и WhatsApp"),
    screens.indexOf("## 9. Особые требования"),
  );
  return [...section.matchAll(/^\|\s*(W-\d+[a-z]?)\s*\|/gm)].map((match) => match[1]!);
}

/** A sound template to break one thing at a time. */
function sound(): MessageTemplateDefinition {
  return {
    screen: "W-99",
    providerName: "adclub_probe",
    category: "utility",
    variables: ["name", "link"],
    buttons: [],
    texts: {
      ru: "{name}, откройте {link}",
      kk: "{name}, {link} ашыңыз",
    },
    sample: { name: "Айгерим", link: "https://cabinet.adclub.kz" },
    sentBy: null,
  };
}

function withProbe(change: (template: MessageTemplateDefinition) => MessageTemplateDefinition) {
  return { probe: change(sound()) } satisfies MessageTemplateRegistry;
}

describe("the registry of message templates (TASK-024 requirement 2)", () => {
  it("is sound: Kazakh and Russian everywhere, the same placeholders, Kazakh not overlong", () => {
    expect(checkTemplateRegistry()).toEqual([]);
  });

  it("holds exactly the templates of SCREENS 8.5", () => {
    const registry = Object.values(messageTemplates).map((template) => template.screen);
    expect([...registry].sort()).toEqual([...screensTemplateIds()].sort());
    expect(registry.length).toBe(10);
  });

  it("has a text in every language for every template, and the buttons of W-01 in both", () => {
    for (const [key, template] of Object.entries(messageTemplates)) {
      for (const lang of MESSAGE_LANGUAGES) {
        expect(template.texts[lang].length, `${key} ${lang}`).toBeGreaterThan(5);
      }
    }
    const titles = messageTemplates.order_new.buttons.map((button) => button.titles);
    expect(titles.map((title) => title.ru)).toEqual([
      "Подтвердить",
      "Отказать",
      "Открыть в кабинете",
    ]);
    expect(titles.every((title) => title.kk.length > 0)).toBe(true);
  });

  it("keeps the wording of the invitation W-08 and its placeholders", () => {
    expect(messageTemplates.supplier_invitation.texts.ru).toBe(
      "{memberName}, вас добавили в кабинет поставщика «{companyName}». Войти: {link}",
    );
    expect(messageTemplates.supplier_invitation.variables).toEqual([
      "memberName",
      "companyName",
      "link",
    ]);
    expect(messageTemplates.supplier_invitation.sentBy).toBe("suppliers.send-invitation");
  });

  it("names the provider templates uniquely and in the form Meta accepts", () => {
    const names = Object.values(messageTemplates).map((template) => template.providerName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^adclub_[a-z0-9_]+$/);
    }
  });

  it("knows its own keys", () => {
    expect(isMessageTemplateKey("supplier_invitation")).toBe(true);
    expect(isMessageTemplateKey("nope")).toBe(false);
    // `Object.hasOwn`, not `in`: a prototype key is not a template.
    expect(isMessageTemplateKey("toString")).toBe(false);
  });
});

describe("what the check of the registry catches", () => {
  it("accepts a sound template", () => {
    expect(checkTemplateRegistry(withProbe((template) => template))).toEqual([]);
  });

  it("catches a template without Kazakh, and one with an empty Russian text", () => {
    expect(
      checkTemplateRegistry(
        withProbe((template) => ({ ...template, texts: { ...template.texts, kk: "" } })),
      ),
    ).toEqual(["probe: no text in kk"]);
    expect(
      checkTemplateRegistry(
        withProbe((template) => ({ ...template, texts: { ...template.texts, ru: "   " } })),
      ),
    ).toEqual(["probe: no text in ru"]);
  });

  it("catches a placeholder that is in one language only", () => {
    const problems = checkTemplateRegistry(
      withProbe((template) => ({
        ...template,
        texts: { ...template.texts, kk: "{name}, ашыңыз" },
      })),
    );
    expect(problems).toEqual(["probe (kk): the declared {link} is not in the text"]);
  });

  it("catches a placeholder the template does not declare", () => {
    const problems = checkTemplateRegistry(
      withProbe((template) => ({
        ...template,
        texts: { ...template.texts, ru: "{name}, {link} {extra}" },
      })),
    );
    expect(problems).toEqual(["probe (ru): the text uses {extra}, which is not declared"]);
  });

  it("catches a placeholder declared twice and two templates with one provider name", () => {
    expect(
      checkTemplateRegistry(
        withProbe((template) => ({ ...template, variables: ["name", "link", "name"] })),
      ),
    ).toContain("probe: a placeholder is declared twice");
    const one = sound();
    expect(checkTemplateRegistry({ first: one, second: { ...one, screen: "W-98" } })).toEqual([
      "second: the provider template name adclub_probe is already used by first",
    ]);
  });

  it("catches a provider name Meta would refuse", () => {
    expect(
      checkTemplateRegistry(withProbe((template) => ({ ...template, providerName: "Probe-1" }))),
    ).toEqual(["probe: the provider template name must be adclub_<lower case and underscores>"]);
  });

  it("catches a Kazakh text that grew far past the Russian one (SCREENS 9.1)", () => {
    const problems = checkTemplateRegistry(
      withProbe((template) => ({
        ...template,
        texts: {
          ...template.texts,
          kk: `{name}, ${"өте ұзақ түсіндірме ".repeat(6)}{link}`,
        },
      })),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      new RegExp(
        `^probe: the Kazakh text is \\d\\.\\d\\d times the Russian one \\(at most ${String(KK_LENGTH_RATIO_MAX)}\\)$`,
      ),
    );
  });

  it("catches a text that does not fit the provider's limit with realistic values", () => {
    const problems = checkTemplateRegistry(
      withProbe((template) => ({
        ...template,
        sample: { name: "А".repeat(TEMPLATE_BODY_MAX_LENGTH), link: "https://x.kz" },
      })),
    );
    expect(problems).toContain(
      `probe (ru): the sample values do not render a text within ${String(TEMPLATE_BODY_MAX_LENGTH)} characters`,
    );
  });

  it("catches button trouble: too many, a long or empty title, a repeated name", () => {
    const button = (name: string, title = "Да") => ({
      kind: "quick_reply" as const,
      name,
      titles: { ru: title, kk: title },
    });
    expect(
      checkTemplateRegistry(
        withProbe((template) => ({
          ...template,
          buttons: [button("a"), button("b"), button("c"), button("d")],
        })),
      ),
    ).toEqual(expect.arrayContaining(["probe: more than three buttons"]));
    expect(
      checkTemplateRegistry(
        withProbe((template) => ({
          ...template,
          buttons: [button("a", "Я".repeat(TEMPLATE_BUTTON_TITLE_MAX_LENGTH + 1))],
        })),
      ),
    ).toEqual([
      // Languages are checked in the order of `MESSAGE_LANGUAGES`: Kazakh first.
      `probe (kk): the title of the button a is longer than ${String(TEMPLATE_BUTTON_TITLE_MAX_LENGTH)} characters`,
      `probe (ru): the title of the button a is longer than ${String(TEMPLATE_BUTTON_TITLE_MAX_LENGTH)} characters`,
    ]);
    expect(
      checkTemplateRegistry(
        withProbe((template) => ({ ...template, buttons: [button("a", " ")] })),
      ),
    ).toEqual(["probe (kk): the button a has no title", "probe (ru): the button a has no title"]);
    expect(
      checkTemplateRegistry(
        withProbe((template) => ({ ...template, buttons: [button("a"), button("a")] })),
      ),
    ).toEqual(["probe: two buttons with the same name"]);
  });
});

describe("rendering a message", () => {
  const values = {
    memberName: "Айгерим",
    companyName: "Автомаркет",
    link: "https://cabinet.adclub.kz",
  };

  it("fills the text of the recipient's language", () => {
    expect(renderMessageText("supplier_invitation", "ru", values)).toBe(
      "Айгерим, вас добавили в кабинет поставщика «Автомаркет». Войти: https://cabinet.adclub.kz",
    );
    expect(renderMessageText("supplier_invitation", "kk", values)).toBe(
      "Айгерим, сізді «Автомаркет» жеткізушісінің кабинетіне қосты. Кіру: https://cabinet.adclub.kz",
    );
  });

  it("takes a value literally, even one that looks like a replacement pattern", () => {
    const text = renderMessageText("supplier_invitation", "ru", {
      ...values,
      companyName: "Цены $& и $1 $$",
    });
    expect(text).toContain("«Цены $& и $1 $$»");
  });

  it("refuses a missing or blank value instead of sending a hole", () => {
    expect(() => renderMessageText("supplier_invitation", "ru", { ...values, link: "" })).toThrow(
      MessageRenderError,
    );
    expect(() =>
      renderMessageText("supplier_invitation", "ru", { memberName: "А", companyName: "Б" }),
    ).toThrow(expect.objectContaining({ reason: "missing_variable" }));
  });

  it("refuses what the provider would refuse in a parameter: a line break, a tab, four spaces", () => {
    for (const bad of ["две\nстроки", "таб\tтут", "много    пробелов"]) {
      expect(() =>
        renderMessageText("supplier_invitation", "ru", { ...values, companyName: bad }),
      ).toThrow(expect.objectContaining({ reason: "unsupported_character" }));
    }
  });

  it("refuses a text over the limit rather than cutting it", () => {
    expect(() => renderMessageText("supplier_invitation", "ru", values, 20)).toThrow(
      expect.objectContaining({ reason: "text_too_long" }),
    );
    // The limit counts characters, not bytes: Cyrillic is two bytes each.
    const text = renderMessageText("admin_message", "ru", { text: "я".repeat(100) });
    expect([...text].length).toBeLessThan(200);
    expect(() =>
      renderMessageText("admin_message", "ru", { text: "я".repeat(100) }, [...text].length),
    ).not.toThrow();
  });

  it("orders the values as the approved template has them, whatever the object's order", () => {
    expect(
      orderedVariables("supplier_invitation", {
        link: "L",
        companyName: "C",
        memberName: "M",
      }),
    ).toEqual(["M", "C", "L"]);
    expect(() => orderedVariables("supplier_invitation", { memberName: "M" })).toThrow(
      MessageRenderError,
    );
  });

  it("finds the placeholders of a text once each, in order", () => {
    expect(placeholdersOf("{a} и {b}, снова {a}")).toEqual(["a", "b"]);
    expect(placeholdersOf("без подстановок")).toEqual([]);
    expect(placeholdersOf("{ a } {1x}")).toEqual([]);
  });
});
