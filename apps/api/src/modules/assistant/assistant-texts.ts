import type { CatalogLanguage } from "@adclub/contracts";

/**
 * The fixed texts of the assistant's answers (SCREENS M-AI-01, T-AI-03), in
 * the language of the interface — the server's own, never the model's.
 */
type Texts = Readonly<Record<CatalogLanguage, string>>;

/** A question that is not about what the club sells (`intent: other`). */
export const OFF_TOPIC_TEXT: Texts = {
  ru: "Я помогаю только с подбором товаров и услуг клуба",
  kk: "Мен тек клубтың тауарлары мен қызметтерін таңдауға көмектесемін",
  en: "I only help to choose goods and services of the club",
};

/** T-AI-03: nothing of the answer is on sale for this car and city. */
export const NOT_FOUND_TEXT: Texts = {
  ru: "В каталоге клуба пока нет подходящего",
  kk: "Клуб каталогында әзірге сәйкес келетін ештеңе жоқ",
  en: "There is nothing suitable in the club catalog yet",
};

/** The model could not finish the turn within its tool calls (it went round in circles). */
export const NOT_PICKED_TEXT: Texts = {
  ru: "Не удалось подобрать. Попробуйте уточнить запрос или найдите в каталоге",
  kk: "Таңдау мүмкін болмады. Сұрауды нақтылаңыз немесе каталогтан іздеңіз",
  en: "Could not pick anything. Try to say it more precisely or search the catalog",
};

/** M-AI-01 «недоступен»: the provider or a daily budget. */
export const UNAVAILABLE_TEXT: Texts = {
  ru: "AI Pilot сейчас недоступен. Попробуйте позже или найдите в каталоге",
  kk: "AI Pilot қазір қолжетімсіз. Кейінірек көріңіз немесе каталогтан іздеңіз",
  en: "AI Pilot is unavailable now. Try later or search the catalog",
};

/** What replaces a text of the model that claims a diagnosis (ARCHITECTURE 11.1 point 5). */
export const NEUTRAL_TEXT: Texts = {
  ru: "Возможные варианты из каталога клуба",
  kk: "Клуб каталогындағы ықтимал нұсқалар",
  en: "Possible options from the club catalog",
};

/** The language the model is told to answer in. */
export const LANGUAGE_NAME: Texts = { ru: "Russian", kk: "Kazakh", en: "English" };
