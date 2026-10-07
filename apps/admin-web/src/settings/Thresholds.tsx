import type { Setting, SettingGroup, SettingListResponse } from "@adclub/contracts";
import { Banner, Button, EmptyState, LoadingContent, SearchField, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { navigateTo, routePaths, settingHistoryPath, useLocation, withQuery } from "../router";
import { useLoad, type Loaded } from "../use-load";
import { SettingDialog } from "./SettingDialog";
import {
  formatValue,
  isClientPolicy,
  rangeText,
  readOnly,
  settingActorText,
} from "./setting-rules";
import { SettingsTabs } from "./SettingsTabs";

/** Every setting, loaded once per page; a saved one replaces its row without a reload. */
export function useSettings(): Loaded<SettingListResponse> & {
  put: (setting: Setting) => void;
  fetchOne: (key: string) => Promise<Setting | null>;
} {
  const list = useLoad(() => apiClient.listSettings(), "settings");
  const put = (setting: Setting) => {
    if (!list.data) return;
    list.replace({
      groups: list.data.groups.map((group) => ({
        ...group,
        settings: group.settings.map((row) => (row.key === setting.key ? setting : row)),
      })),
    });
  };
  const fetchOne = async (key: string) => {
    const fresh = await apiClient.listSettings();
    list.replace(fresh);
    return fresh.groups.flatMap((group) => group.settings).find((row) => row.key === key) ?? null;
  };
  return { ...list, put, fetchOne };
}

function matches(setting: Setting, query: string): boolean {
  if (!query) return true;
  const text = `${setting.key} ${setting.description}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

/**
 * A-SET-01 «Пороги и лимиты» (SCREENS 7.9; TASK-034 requirement 4): every
 * setting of the registry by its group — what it does, the range and unit,
 * the value in effect and the default, who changed it last and when. The
 * sign-in security settings are read-only with the note: only the server
 * operator changes them (D-053). The client policy has a page of its own.
 */
export function Thresholds() {
  const settings = useSettings();
  const location = useLocation();
  const query = location.query.get("q") ?? "";
  const [editing, setEditing] = useState<Setting | null>(null);

  const groups: SettingGroup[] = (settings.data?.groups ?? [])
    .map((group) => ({
      ...group,
      settings: group.settings.filter((row) => !isClientPolicy(row.key) && matches(row, query)),
    }))
    .filter((group) => group.settings.length > 0);

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Настройки</h1>
      </div>
      <SettingsTabs active="settings" />
      <div className="filters">
        <SearchField
          label="Найти настройку"
          placeholder="Название или ключ, например «срок ответа»"
          value={query}
          onChange={(value) =>
            navigateTo(withQuery(routePaths.settings, { q: value }), { replace: true })
          }
          clearLabel="Очистить"
        />
      </div>
      {settings.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={settings.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(settings.error)}
        </Banner>
      )}
      <LoadingContent
        ready={settings.data !== undefined}
        indicator={settings.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        {groups.length === 0 ? (
          <EmptyState icon="search" title="Ничего не нашлось" text="Попробуйте другое слово" />
        ) : (
          groups.map((group) => (
            <section
              key={group.id}
              className="settings-group"
              aria-labelledby={`group-${group.id}`}
            >
              <h2 id={`group-${group.id}`} className="ac-text-heading">
                {group.title}
              </h2>
              <SettingsTable settings={group.settings} onEdit={setEditing} />
            </section>
          ))
        )}
      </LoadingContent>
      <SettingDialog
        setting={editing}
        onCancel={() => setEditing(null)}
        onSaved={(saved) => {
          settings.put(saved);
          setEditing(null);
        }}
        reloadSetting={settings.fetchOne}
      />
    </>
  );
}

/** The rows of settings — also the table of the client policy. */
export function SettingsTable({
  settings,
  onEdit,
  label = (setting: Setting) => setting.description,
}: {
  settings: readonly Setting[];
  onEdit: (setting: Setting) => void;
  label?: (setting: Setting) => string;
}) {
  return (
    <div className="table-wrap">
      <table className="admin-table settings-table">
        <thead>
          <tr>
            <th scope="col">Настройка</th>
            <th scope="col">Значение</th>
            <th scope="col">Кто менял</th>
            <th scope="col" className="admin-table__actions">
              Действия
            </th>
          </tr>
        </thead>
        <tbody>
          {settings.map((setting) => (
            <tr key={setting.key}>
              <td>
                <div className="cell-stack">
                  <span className="ac-text-body-s">{label(setting)}</span>
                  <span className="ac-text-caption ac-muted">
                    <code>{setting.key}</code>
                    {rangeText(setting) ? ` · ${rangeText(setting)}` : ""}
                  </span>
                </div>
              </td>
              <td>
                <div className="cell-stack">
                  <span className="ac-text-body-strong value-text">
                    {formatValue(setting, setting.value)}
                  </span>
                  <span className="ac-text-caption ac-muted">
                    {setting.isDefault
                      ? "по умолчанию"
                      : `по умолчанию: ${formatValue(setting, setting.defaultValue)}`}
                  </span>
                  {setting.storedValueInvalid && (
                    <span className="ac-text-caption warning-text">
                      Сохранённое значение негодно — действует по умолчанию
                    </span>
                  )}
                </div>
              </td>
              <td>
                {setting.lastChange ? (
                  <div className="cell-stack">
                    <span className="ac-text-body-s">
                      {settingActorText(setting.lastChange.by)}
                    </span>
                    <span className="ac-text-caption ac-muted">
                      {formatMoment(setting.lastChange.at)}
                    </span>
                  </div>
                ) : (
                  <span className="ac-text-caption ac-muted">не менялась</span>
                )}
              </td>
              <td className="admin-table__actions">
                <div className="button-row button-row--end">
                  {readOnly(setting) ? (
                    <span className="ac-text-caption ac-muted readonly-note">
                      меняет только оператор сервера
                    </span>
                  ) : (
                    <Button variant="secondary" size="s" onClick={() => onEdit(setting)}>
                      Изменить
                    </Button>
                  )}
                  <Button
                    variant="text"
                    size="s"
                    onClick={() => navigateTo(settingHistoryPath(setting.key))}
                  >
                    История
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
