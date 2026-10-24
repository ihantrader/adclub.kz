import type { Setting, SettingGroup, SettingListResponse } from "@adclub/contracts";
import {
  Banner,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  TypeMark,
} from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { FilterSearch } from "../layout/filters";
import { Header, Table } from "../layout/layout";
import { useAdminNames } from "../people/use-admin-names";
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
import { settingsTabs } from "./SettingsTabs";

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
 * A-SET-01 «Пороги и лимиты» (SCREENS 7.9; TASK-034, TASK-080 X22): the
 * groups of the registry in a list on the left, one group at a time on the
 * right (in the address, `?group=`) — never one page of 17 000 px. The
 * search looks through every group and shows each group that has a match.
 * A row: what the setting does and its range in words, the value in effect
 * and the default, who changed it last and when, «Изменить» and the
 * history. The sign-in security settings are read-only: only the server
 * operator changes them (D-053). The client policy has a page of its own.
 */
export function Thresholds() {
  const settings = useSettings();
  const names = useAdminNames();
  const location = useLocation();
  const query = location.query.get("q") ?? "";
  const [search, setSearch] = useState(query);
  const [editing, setEditing] = useState<Setting | null>(null);

  const all: SettingGroup[] = (settings.data?.groups ?? [])
    .map((group) => ({
      ...group,
      settings: group.settings.filter((row) => !isClientPolicy(row.key)),
    }))
    .filter((group) => group.settings.length > 0);
  const found = all
    .map((group) => ({ ...group, settings: group.settings.filter((row) => matches(row, query)) }))
    .filter((group) => group.settings.length > 0);
  const asked = location.query.get("group");
  const chosen = all.find((group) => group.id === asked) ?? all[0];
  const shown = query ? found : chosen ? [chosen] : [];

  const go = (values: { group?: string; q?: string }) =>
    navigateTo(withQuery(routePaths.settings, values), { replace: true });

  return (
    <>
      <Header title="Настройки" tabs={settingsTabs("settings")} />
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
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Группы настроек">
            <FilterSearch
              label="Найти настройку"
              placeholder="Название или ключ"
              value={search}
              onChange={(value) => {
                setSearch(value);
                go({ group: chosen?.id, q: value.trim() || undefined });
              }}
            />
            <ul className="settings-nav__list">
              {all.map((group) => {
                const hits = query
                  ? (found.find((entry) => entry.id === group.id)?.settings.length ?? 0)
                  : group.settings.length;
                const on = !query && group.id === chosen?.id;
                return (
                  <li key={group.id}>
                    <a
                      href={withQuery(routePaths.settings, { group: group.id })}
                      className={
                        on
                          ? "settings-nav__item settings-nav__item--on"
                          : query && hits === 0
                            ? "settings-nav__item settings-nav__item--empty"
                            : "settings-nav__item"
                      }
                      aria-current={on ? "page" : undefined}
                      onClick={(event) => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
                        event.preventDefault();
                        setSearch("");
                        go({ group: group.id });
                      }}
                    >
                      <span>{group.title}</span>
                      <span className="settings-nav__count">{hits}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="settings-groups">
            {shown.length === 0 ? (
              <EmptyState
                icon="search"
                title="Ничего не нашлось"
                text="Попробуйте другое слово"
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearch("");
                      go({ group: chosen?.id });
                    }}
                  >
                    Сбросить поиск
                  </Button>
                }
              />
            ) : (
              shown.map((group) => (
                <section key={group.id} className="section" aria-labelledby={`group-${group.id}`}>
                  <div className="section__head">
                    <h2 id={`group-${group.id}`} className="section__title">
                      {group.title}
                    </h2>
                  </div>
                  <SettingsTable
                    settings={group.settings}
                    onEdit={setEditing}
                    names={names}
                    caption={group.title}
                  />
                </section>
              ))
            )}
          </div>
        </div>
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

const COLUMNS = [
  { key: "setting", header: "Настройка" },
  { key: "value", header: "Значение", width: 240 },
  { key: "changed", header: "Изменено", width: 180 },
  { key: "actions", header: "Действия", width: 152, actions: true, hiddenHeader: true },
];

/** The rows of settings — also the table of the client policy; the same widths everywhere. */
export function SettingsTable({
  settings,
  onEdit,
  names,
  caption,
  label = (setting: Setting) => setting.description,
}: {
  settings: readonly Setting[];
  onEdit: (setting: Setting) => void;
  names?: ReadonlyMap<string, string | null>;
  caption: string;
  label?: (setting: Setting) => string;
}) {
  return (
    <Table label={caption} columns={COLUMNS} className="settings-table">
      {settings.map((setting) => {
        const value = formatValue(setting, setting.value);
        const range = rangeText(setting);
        return (
          <tr key={setting.key}>
            <td>
              <span className="cell-stack">
                <span className="ac-text-body-s">{label(setting)}</span>
                <span className="row-title__sub" title={`Ключ настройки: ${setting.key}`}>
                  {range ?? "Без ограничений"}
                </span>
              </span>
            </td>
            <td>
              <span className="cell-stack">
                <span className="ac-text-body-strong clamp" title={value}>
                  {value}
                </span>
                <span className="row-title__sub">
                  {setting.isDefault
                    ? "по умолчанию"
                    : `по умолчанию: ${formatValue(setting, setting.defaultValue)}`}
                </span>
                {setting.storedValueInvalid && (
                  <span className="ac-text-caption warning-text">
                    Сохранённое значение негодно — действует по умолчанию
                  </span>
                )}
              </span>
            </td>
            <td>
              {setting.lastChange ? (
                <span className="cell-stack">
                  <span className="ac-text-body-s cell-one-line">
                    {settingActorText(setting.lastChange.by, names)}
                  </span>
                  <span className="row-title__sub nowrap">
                    {formatMoment(setting.lastChange.at)}
                  </span>
                </span>
              ) : (
                <span className="ac-text-body-s ac-muted nowrap">не менялась</span>
              )}
            </td>
            <td className="admin-table__actions">
              <span className="row-actions">
                {readOnly(setting) ? (
                  <span title="Меняет только оператор сервера">
                    <TypeMark icon="lock">Только оператор</TypeMark>
                  </span>
                ) : (
                  <Button variant="secondary" size="s" onClick={() => onEdit(setting)}>
                    Изменить
                  </Button>
                )}
                <IconButton
                  icon="history"
                  size={20}
                  label="История изменений"
                  className="ac-icon-button--s"
                  onClick={() => navigateTo(settingHistoryPath(setting.key))}
                />
              </span>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}
