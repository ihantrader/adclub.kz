import type { Setting, SettingChange } from "@adclub/contracts";
import { Banner, Button, EmptyState, IconButton, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { Header, Table } from "../layout/layout";
import { useAdminNames } from "../people/use-admin-names";
import { routePaths, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import { formatValue, rangeText, settingActorText } from "./setting-rules";
import { SETTINGS_CRUMB } from "./SettingsTabs";
import { useSettings } from "./Thresholds";

const PAGE = 20;

const COLUMNS = [
  { key: "at", header: "Когда", width: 136 },
  { key: "who", header: "Кто", width: 180 },
  { key: "change", header: "Было → стало" },
  { key: "reason", header: "Причина", width: 280 },
];

/**
 * The history of one setting (A-SET-01: «кто и когда менял»; TASK-034,
 * TASK-080): the crumbs of «Настройки» and its group, the setting by its
 * description, a page at a time by the server's cursor — who by name, when
 * in one line, «было → стало» (the model the journal follows, X16), why.
 */
export function SettingHistory() {
  const key = useLocation().id ?? "";
  const settings = useSettings();
  const names = useAdminNames();
  const group = settings.data?.groups.find((entry) =>
    entry.settings.some((row) => row.key === key),
  );
  const setting = group?.settings.find((row) => row.key === key);
  const first = useLoad(
    () => apiClient.getSettingHistory({ key }, { query: { limit: PAGE } }),
    `history/${key}`,
  );
  const [older, setOlder] = useState<{
    key: string;
    changes: SettingChange[];
    next: string | null;
  }>({ key: "", changes: [], next: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const extra = older.key === key ? older : { key, changes: [], next: null };
  const changes = [...(first.data?.changes ?? []), ...extra.changes];
  const next = extra.changes.length > 0 ? extra.next : (first.data?.nextCursor ?? null);

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await apiClient.getSettingHistory(
        { key },
        { query: { limit: PAGE, cursor: next } },
      );
      setOlder({ key, changes: [...extra.changes, ...page.changes], next: page.nextCursor });
    } catch (thrown) {
      setMoreError(loadErrorText(thrown));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <Header
        crumbs={[
          SETTINGS_CRUMB,
          ...(group
            ? [{ label: group.title, href: withQuery(routePaths.settings, { group: group.id }) }]
            : []),
        ]}
        title={setting ? setting.description : "История настройки"}
        subtitle={
          <>
            <span>История изменений</span>
            {setting && rangeText(setting) && <span>{rangeText(setting)}</span>}
            <span className="code-text" title="Ключ настройки">
              {key}
            </span>
          </>
        }
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={first.reload} />}
      />
      {first.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={first.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(first.error)}
        </Banner>
      )}
      <LoadingContent
        ready={first.data !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        <div className="list-block">
          {changes.length === 0 ? (
            <EmptyState
              icon="history"
              title="Настройку ещё не меняли"
              text="Действует значение по умолчанию"
            />
          ) : (
            <Table label="История настройки, время — Алматы" columns={COLUMNS}>
              {changes.map((change) => (
                <tr key={change.id}>
                  <td className="nowrap ac-text-body-s">{formatMoment(change.at)}</td>
                  <td className="ac-text-body-s">
                    <span className="cell-one-line">{settingActorText(change.by, names)}</span>
                  </td>
                  <td>
                    <Change change={change} setting={setting} />
                  </td>
                  <td className="ac-text-body-s">{change.reason}</td>
                </tr>
              ))}
            </Table>
          )}
          {moreError && <Banner tone="danger">{moreError}</Banner>}
          {next && (
            <Button variant="secondary" size="s" onClick={loadMore} loading={loadingMore}>
              Показать ещё
            </Button>
          )}
        </div>
      </LoadingContent>
    </>
  );
}

function Change({ change, setting }: { change: SettingChange; setting: Setting | undefined }) {
  const text = (value: unknown, isDefault: boolean) =>
    `${setting ? formatValue(setting, value) : String(value)}${isDefault ? " (по умолчанию)" : ""}`;
  return (
    <span className="change-line">
      <span className="change-line__old">
        {text(change.previousValue, change.previousIsDefault)}
      </span>
      <span className="change-line__arrow" aria-label="стало">
        {" → "}
      </span>
      <span className="change-line__new">{text(change.newValue, change.newIsDefault)}</span>
    </span>
  );
}
