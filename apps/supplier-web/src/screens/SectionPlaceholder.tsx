import type { IconName } from "@adclub/ui-core";
import { EmptyState } from "@adclub/ui";
import { useT } from "../i18n";

/**
 * «Заявки», «Предложения», «Сканер» are filled by TASK-032 and TASK-033:
 * until then each says so plainly, under its own title — no imitation of
 * data (TASK-031 requirement 1).
 */
export function SectionPlaceholder({ title, icon }: { title: string; icon: IconName }) {
  const t = useT();
  return (
    <>
      <h1 className="ac-text-title-l page__title">{title}</h1>
      <EmptyState icon={icon} title={title} text={t("placeholder.text")} />
    </>
  );
}
