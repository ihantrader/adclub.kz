import { EmptyState } from "@adclub/ui";
import type { IconName } from "@adclub/ui-core";

/**
 * A section of the next tasks (SCREENS 7.2–7.6): an honest «появится»
 * instead of a half-made page. Until then these things are done by the
 * operator command and the API (CLAUDE.md, «Админка в dev»).
 */
export function Coming({ title, icon, task }: { title: string; icon: IconName; task: string }) {
  return (
    <>
      <h1 className="ac-text-title-l page__title">{title}</h1>
      <EmptyState
        icon={icon}
        title="Раздел появится в следующей версии админки"
        text={`Его делает ${task}. До этого то же самое делается командами оператора сервера и запросами к API.`}
      />
    </>
  );
}
