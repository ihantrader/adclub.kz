import type { Setting, SettingChange } from "@adclub/contracts";
import { Banner, Button, EmptyState, IconButton, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { goBack, useLocation } from "../router";
import { useLoad } from "../use-load";
import { formatValue, settingActorText } from "./setting-rules";
import { useSettings } from "./Thresholds";

const PAGE = 20;

/**
 * The history of one setting (A-SET-01: «кто и когда менял»), a page at a
 * time by the server's cursor (TASK-034): who, when, «было → стало», why.
 */
export function SettingHistory() {
  const key = useLocation().id ?? "";
  const settings = useSettings();
  const setting = settings.data?.groups
    .flatMap((group) => group.settings)
    .find((row) => row.key === key);
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
      <div className="page__head page__head--back">
        <IconButton
          icon="arrowLeft"
          label="Назад к настройкам"
          onClick={() => goBack("settings")}
        />
        <div className="cell-stack">
          <h1 className="ac-text-title page__title">История настройки</h1>
          <span className="ac-text-body-s ac-muted">
            {setting ? setting.description : ""} <code>{key}</code>
          </span>
        </div>
      </div>
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
        {changes.length === 0 ? (
          <EmptyState
            icon="clock"
            title="Настройку ещё не меняли"
            text="Действует значение по умолчанию"
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Кто</th>
                  <th scope="col">Было → стало</th>
                  <th scope="col">Причина</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.id}>
                    <td className="num">{formatMoment(change.at)}</td>
                    <td>{settingActorText(change.by)}</td>
                    <td>
                      <Change change={change} setting={setting} />
                    </td>
                    <td className="ac-text-body-s">{change.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {moreError && <Banner tone="danger">{moreError}</Banner>}
        {next && (
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Показать ещё
          </Button>
        )}
      </LoadingContent>
    </>
  );
}

function Change({ change, setting }: { change: SettingChange; setting: Setting | undefined }) {
  const text = (value: unknown, isDefault: boolean) =>
    `${setting ? formatValue(setting, value) : JSON.stringify(value)}${isDefault ? " (по умолчанию)" : ""}`;
  return (
    <span className="was-now__line">
      <span className="was-now__value">{text(change.previousValue, change.previousIsDefault)}</span>
      <span aria-hidden="true">→</span>
      <span className="was-now__value was-now__value--new">
        {text(change.newValue, change.newIsDefault)}
      </span>
    </span>
  );
}
