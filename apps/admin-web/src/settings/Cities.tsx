import { isApiError } from "@adclub/api-client";
import type { AdminCity, AdminCityListResponse } from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  IconButton,
  LoadingContent,
  MenuButton,
  SkeletonList,
  StatusBadge,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { actionErrorText, loadErrorText } from "../errors";
import { useLoad } from "../use-load";
import { Header, Table } from "../layout/layout";
import { settingsTabs } from "./SettingsTabs";

const COLUMNS = [
  { key: "city", header: "Город" },
  { key: "names", header: "Казахский · английский", width: 300 },
  { key: "state", header: "Состояние", width: 140 },
  { key: "actions", header: "Действия", width: 168, actions: true, hiddenHeader: true },
];

type Names = { ru: string; kk: string; en: string };

function cityError(thrown: unknown): string {
  if (isApiError(thrown)) {
    switch (thrown.code) {
      case "CITY_VERSION_CONFLICT":
      case "CITY_ORDER_MISMATCH":
        return "Эти данные только что изменил другой администратор. Обновите страницу";
      case "CITY_DUPLICATE":
        return "Город с таким названием или кодом уже есть";
      default:
        break;
    }
  }
  return actionErrorText(thrown);
}

/**
 * A-SET-06 «Города» (SCREENS 7.9; TASK-016 on the server): names in kk/ru/en
 * written by hand, «активен» or in the archive (whoever chose a city keeps
 * it), the order by arrows. Every change goes with the city's version; a
 * colleague's change meanwhile comes back as a conflict.
 */
export function Cities() {
  const toast = useToast();
  const online = useOnline();
  const list = useLoad<AdminCityListResponse>(() => apiClient.listAdminCities(), "cities");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminCity | "new" | null>(null);
  const [archiving, setArchiving] = useState<AdminCity | null>(null);
  const cities = list.data?.cities ?? [];

  const fail = (thrown: unknown) => setError(cityError(thrown));

  const move = async (index: number, by: -1 | 1) => {
    const order = cities.map((city) => city.id);
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    setError(null);
    try {
      list.replace(await apiClient.reorderCities({ cityIds: order }));
    } catch (thrown) {
      fail(thrown);
    }
  };

  const setStatus = async (city: AdminCity, status: "active" | "archived") => {
    setError(null);
    try {
      await apiClient.setCityStatus({ cityId: city.id }, { status, expectedVersion: city.version });
      toast.show(status === "archived" ? "Город в архиве" : "Город снова активен");
      list.reload();
    } catch (thrown) {
      fail(thrown);
    } finally {
      setArchiving(null);
    }
  };

  return (
    <>
      <Header
        title="Настройки"
        tabs={settingsTabs("cities")}
        actions={
          <>
            <IconButton icon="refresh" label="Обновить" size={20} onClick={list.reload} />
            <Button size="s" icon="plus" disabled={!online} onClick={() => setEditing("new")}>
              Добавить город
            </Button>
          </>
        }
      />
      {error && (
        <Banner
          tone="warning"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() => {
                setError(null);
                list.reload();
              }}
            >
              Обновить данные
            </Button>
          }
        >
          {error}
        </Banner>
      )}
      {list.error !== undefined && <Banner tone="danger">{loadErrorText(list.error)}</Banner>}
      <LoadingContent
        ready={list.data !== undefined}
        indicator={list.indicator}
        label="Загрузка"
        lock
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <Table label="Города" columns={COLUMNS}>
          {cities.map((city, index) => (
            <tr key={city.id} className={city.status === "archived" ? "row--muted" : undefined}>
              <td>
                <span className="order-name">
                  <span className="order-arrows">
                    <IconButton
                      icon="arrowUp"
                      size={20}
                      className="ac-icon-button--s"
                      label={`Выше: ${city.names.ru}`}
                      disabled={!online || index === 0}
                      onClick={() => move(index, -1)}
                    />
                    <IconButton
                      icon="arrowDown"
                      size={20}
                      className="ac-icon-button--s"
                      label={`Ниже: ${city.names.ru}`}
                      disabled={!online || index === cities.length - 1}
                      onClick={() => move(index, 1)}
                    />
                  </span>
                  <span className="cell-stack">
                    <span className="ac-text-body-strong">{city.names.ru}</span>
                    <span className="row-title__sub">
                      <span className="code-text">{city.code}</span>
                      {city.isDefault ? " · город по умолчанию" : ""}
                    </span>
                  </span>
                </span>
              </td>
              <td className="ac-text-body-s">
                <span className="cell-stack">
                  <span>
                    {city.names.kk ?? <span className="warning-text">нет казахского</span>}
                  </span>
                  <span>
                    {city.names.en ?? <span className="warning-text">нет английского</span>}
                  </span>
                </span>
              </td>
              <td>
                <StatusBadge kind="entry" status={city.status}>
                  {city.status === "active" ? "Активен" : "В архиве"}
                </StatusBadge>
              </td>
              <td className="admin-table__actions">
                <span className="row-actions">
                  <Button
                    variant="secondary"
                    size="s"
                    disabled={!online}
                    onClick={() => setEditing(city)}
                  >
                    Изменить
                  </Button>
                  <MenuButton
                    size="s"
                    label={`Действия: ${city.names.ru}`}
                    disabled={!online}
                    actions={[
                      city.status === "active"
                        ? {
                            key: "archive",
                            label: "В архив…",
                            icon: "archive",
                            destructive: true,
                            onSelect: () => setArchiving(city),
                          }
                        : {
                            key: "restore",
                            label: "Восстановить",
                            icon: "circleCheck",
                            onSelect: () => void setStatus(city, "active"),
                          },
                    ]}
                  />
                </span>
              </td>
            </tr>
          ))}
        </Table>
      </LoadingContent>

      <CityDialog
        city={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          toast.show("Сохранено");
          list.reload();
        }}
      />
      <Dialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title="Убрать город в архив?"
        actions={
          <>
            <Button onClick={() => archiving && setStatus(archiving, "archived")}>В архив</Button>
            <Button variant="secondary" onClick={() => setArchiving(null)}>
              Отмена
            </Button>
          </>
        }
      >
        {archiving && (
          <>
            «{archiving.names.ru}» больше нельзя будет выбрать. Кто уже выбрал его — пользователи и
            поставщики — сохранят его. Вернуть можно кнопкой «Восстановить».
          </>
        )}
      </Dialog>
    </>
  );
}

function CityDialog({
  city,
  onCancel,
  onSaved,
}: {
  city: AdminCity | "new" | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [shown, setShown] = useState<AdminCity | "new" | null>(null);
  const [code, setCode] = useState("");
  const [names, setNames] = useState<Names>({ ru: "", kk: "", en: "" });
  const [error, setError] = useState<string | null>(null);
  if (city !== shown) {
    setShown(city);
    setCode("");
    setError(null);
    setNames(
      city && city !== "new"
        ? { ru: city.names.ru, kk: city.names.kk ?? "", en: city.names.en ?? "" }
        : { ru: "", kk: "", en: "" },
    );
  }

  const submit = async () => {
    if (!city) return;
    if (!names.ru.trim()) {
      setError("Русское название обязательно");
      return;
    }
    const optional = (value: string) => (value.trim() ? value.trim() : null);
    try {
      if (city === "new") {
        if (!/^[a-z][a-z0-9-]*$/.test(code.trim())) {
          setError("Код — латинские буквы, цифры и дефис, например ekibastuz");
          return;
        }
        await apiClient.createCity({
          code: code.trim(),
          names: { ru: names.ru.trim(), kk: optional(names.kk), en: optional(names.en) },
        });
      } else {
        await apiClient.updateCity(
          { cityId: city.id },
          {
            expectedVersion: city.version,
            names: { ru: names.ru.trim(), kk: optional(names.kk), en: optional(names.en) },
          },
        );
      }
      onSaved();
    } catch (thrown) {
      setError(cityError(thrown));
    }
  };

  return (
    <Dialog
      open={city !== null}
      onClose={onCancel}
      title={city === "new" ? "Новый город" : "Изменить город"}
      actions={
        <>
          <Button onClick={submit}>Сохранить</Button>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        {city === "new" && (
          <TextField
            label="Код"
            value={code}
            onChange={setCode}
            hint="Латиницей, не меняется: ekibastuz"
            autoComplete="off"
          />
        )}
        <TextField label="Русский" value={names.ru} onChange={(ru) => setNames({ ...names, ru })} />
        <TextField
          label="Казахский"
          value={names.kk}
          onChange={(kk) => setNames({ ...names, kk })}
        />
        <TextField
          label="Английский"
          value={names.en}
          onChange={(en) => setNames({ ...names, en })}
        />
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  );
}
