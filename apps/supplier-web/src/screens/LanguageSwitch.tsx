import { languages, type Lang } from "@adclub/i18n";
import { Segments } from "@adclub/ui";
import { useLanguage } from "../i18n";

/** The interface language, each option in its own language (kk/ru/en). */
export function LanguageSwitch({ label }: { label?: string }) {
  const { lang, setLang, t } = useLanguage();
  return (
    <Segments<Lang>
      label={label ?? t("language.label")}
      value={lang}
      onChange={setLang}
      options={languages.map((candidate) => ({
        value: candidate,
        label: t(`language.${candidate}`),
      }))}
    />
  );
}
