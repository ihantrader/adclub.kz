import { useEffect, useState } from "react";
import { apiClient } from "../api";

/** One read of the settings per page load: their descriptions by key. */
let titles: Promise<Map<string, string>> | null = null;

function loadTitles(): Promise<Map<string, string>> {
  titles ??= apiClient.listSettings().then(
    (answer) =>
      new Map(
        answer.groups.flatMap((group) =>
          group.settings.map((setting) => [setting.key, setting.description] as const),
        ),
      ),
    () => {
      titles = null;
      return new Map<string, string>();
    },
  );
  return titles;
}

/**
 * A setting in the journal by what it does, not by its key (TASK-080, X16:
 * «Настройка: login_code_verifications_per_phone» → its description). Asked
 * only when the journal names a setting; until the answer — the key.
 */
export function useSettingTitles(needed: boolean): ReadonlyMap<string, string> {
  const [map, setMap] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    void loadTitles().then((loaded) => {
      if (!cancelled) setMap(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [needed]);
  return map;
}
