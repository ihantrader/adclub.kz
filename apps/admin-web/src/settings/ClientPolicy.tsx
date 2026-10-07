import type { Setting } from "@adclub/contracts";
import { Banner, Button, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { APP_VERSION } from "../api";
import { loadErrorText } from "../errors";
import { SettingDialog } from "./SettingDialog";
import { CLIENT_POLICY_KEYS, CLIENT_POLICY_LABELS } from "./setting-rules";
import { SettingsTabs } from "./SettingsTabs";
import { SettingsTable, useSettings } from "./Thresholds";

/**
 * A-SET-02 «Политика клиента» (SCREENS 7.9): the minimum version of each
 * client and the text of «Нужно обновить» in kk/ru/en. A build below its
 * minimum is stopped by the server on its next request. The admin panel's
 * minimum can't be set above its current release — the server refuses, and
 * the dialog shows its answer.
 */
export function ClientPolicy() {
  const settings = useSettings();
  const [editing, setEditing] = useState<Setting | null>(null);
  const all = settings.data?.groups.flatMap((group) => group.settings) ?? [];
  const rows = Object.values(CLIENT_POLICY_KEYS)
    .map((key) => all.find((setting) => setting.key === key))
    .filter((setting): setting is Setting => setting !== undefined);

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Настройки</h1>
      </div>
      <SettingsTabs active="clientPolicy" />
      <p className="ac-text-body-s ac-muted">
        Версия, ниже которой приложение, кабинет или админка перестают работать и просят обновиться.
        Действует не позже чем через 30 секунд. Эта админка — версии {APP_VERSION}.
      </p>
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
        <SettingsTable
          settings={rows}
          onEdit={setEditing}
          label={(setting) => CLIENT_POLICY_LABELS[setting.key] ?? setting.description}
        />
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
