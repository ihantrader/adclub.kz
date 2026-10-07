import { isApiError } from "@adclub/api-client";
import type {
  AdminVehicleOption,
  AdminVehicleOptionListResponse,
  VehicleOptionKind,
} from "@adclub/contracts";
import { auditActions, auditEntities, vehicleOptionKindSchema } from "@adclub/contracts";
import {
  Banner,
  Button,
  Chip,
  IconButton,
  LoadingContent,
  SkeletonList,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { actorText } from "../audit/audit-words";
import { navigateTo, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import { OptionDialog } from "./dialogs";
import {
  FormError,
  LoadError,
  StatusDialog,
  StatusMark,
  useStatusFlow,
  VehiclesTabs,
} from "./shared";
import { conflictText, OPTION_KIND_TEXT, vehicleErrorView } from "./vehicle-words";

const KINDS = vehicleOptionKindSchema.options;

/** Who put a list in another order last — or added an option to it (the journal decides). */
async function whoReordered(): Promise<string | null> {
  try {
    const [reordered, created] = await Promise.all([
      apiClient.listAuditLog({ query: { action: auditActions.vehicleOptionsReordered, limit: 1 } }),
      apiClient.listAuditLog({ query: { action: auditActions.vehicleOptionCreated, limit: 1 } }),
    ]);
    const latest = [reordered.entries[0], created.entries[0]]
      .filter((entry) => entry !== undefined)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    return latest ? actorText(latest.actor) : null;
  } catch {
    return null;
  }
}

/**
 * A-CAR-01, the reference lists — body, gearbox, drive, fuel (TASK-035.B;
 * ARCHITECTURE 4.24 I215): code, names in kk/ru/en written by hand (these
 * lists are never translated automatically), the order by arrows (sent
 * with the order it was made from), archive and restore. An option is
 * named in an import file by its code or any of its names.
 */
export function Options() {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const asked = location.query.get("kind");
  const kind: VehicleOptionKind = KINDS.includes(asked as VehicleOptionKind)
    ? (asked as VehicleOptionKind)
    : "body";
  const highlight = location.query.get("highlight");
  const list = useLoad<AdminVehicleOptionListResponse>(
    () => apiClient.listVehicleOptions({ query: { kind } }),
    kind,
  );
  const [editing, setEditing] = useState<AdminVehicleOption | "new" | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const options = list.data?.options ?? [];
  const status = useStatusFlow<AdminVehicleOption>(
    auditEntities.vehicleOption,
    async (option, to, version) =>
      (
        await apiClient.setVehicleOptionStatus(
          { optionId: option.id },
          { status: to, expectedVersion: version },
        )
      ).option,
    (option) => {
      list.reload();
      toast.show(option.status === "archived" ? "Значение в архиве" : "Значение снова активно");
    },
    () => ({ kind }),
  );

  const move = async (index: number, by: -1 | 1) => {
    const read = options.map((option) => option.id);
    const order = [...read];
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    setOrderError(null);
    try {
      const answer = await apiClient.reorderVehicleOptions({
        kind,
        optionIds: order,
        expectedOrder: read,
      });
      list.replace(answer);
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "VEHICLE_ORDER_CONFLICT") {
        setOrderError(conflictText(await whoReordered()));
        list.reload();
      } else {
        setOrderError(vehicleErrorView(thrown).text);
      }
    }
  };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Автомобили</h1>
        <div className="page__tools">
          <Button size="s" icon="plus" disabled={!online} onClick={() => setEditing("new")}>
            Новое значение
          </Button>
        </div>
      </div>
      <VehiclesTabs active="options" />
      <div className="chips" role="group" aria-label="Список">
        {KINDS.map((entry) => (
          <Chip
            key={entry}
            selected={entry === kind}
            onClick={() =>
              navigateTo(withQuery("/vehicles/options", { kind: entry }), { replace: true })
            }
          >
            {OPTION_KIND_TEXT[entry]}
          </Chip>
        ))}
      </div>
      <p className="ac-text-body-s ac-muted">
        Названия на казахском и английском вводятся вручную — автоперевода у этих списков нет. Файл
        импорта называет значение кодом или любым названием.
      </p>
      {orderError && (
        <Banner
          tone="warning"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() => {
                setOrderError(null);
                list.reload();
              }}
            >
              Обновить
            </Button>
          }
        >
          {orderError}
        </Banner>
      )}
      <LoadError error={list.error} retry={list.reload} />
      <LoadingContent
        ready={list.data !== undefined}
        indicator={list.indicator}
        label="Загрузка"
        swapKey={list.answerKey}
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <div className="table-wrap">
          <table className="admin-table vehicles-table">
            <thead>
              <tr>
                <th scope="col">Порядок</th>
                <th scope="col">Русский</th>
                <th scope="col">Казахский</th>
                <th scope="col">Английский</th>
                <th scope="col">Статус</th>
                <th scope="col" className="admin-table__actions">
                  Действия
                </th>
              </tr>
            </thead>
            <tbody>
              {options.map((option, index) => (
                <tr
                  key={option.id}
                  className={
                    option.id === highlight
                      ? "row--highlight"
                      : option.status === "archived"
                        ? "row--muted"
                        : undefined
                  }
                >
                  <td>
                    <div className="button-row">
                      <IconButton
                        icon="arrowLeft"
                        className="arrow-up"
                        label={`Выше: ${option.names.ru}`}
                        disabled={!online || index === 0}
                        onClick={() => move(index, -1)}
                      />
                      <IconButton
                        icon="arrowLeft"
                        className="arrow-down"
                        label={`Ниже: ${option.names.ru}`}
                        disabled={!online || index === options.length - 1}
                        onClick={() => move(index, 1)}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className="ac-text-body-strong">{option.names.ru}</span>
                      <code className="ac-text-caption ac-muted">{option.code}</code>
                    </div>
                  </td>
                  <td className="ac-text-body-s">
                    {option.names.kk ?? <span className="warning-text">нет</span>}
                  </td>
                  <td className="ac-text-body-s">
                    {option.names.en ?? <span className="warning-text">нет</span>}
                  </td>
                  <td>
                    <StatusMark status={option.status} />
                  </td>
                  <td className="admin-table__actions">
                    <div className="button-row button-row--end">
                      <Button
                        variant="secondary"
                        size="s"
                        disabled={!online}
                        onClick={() => setEditing(option)}
                      >
                        Изменить
                      </Button>
                      <Button
                        variant="text"
                        size="s"
                        disabled={!online}
                        onClick={() => status.open(option)}
                      >
                        {option.status === "active" ? "В архив" : "Восстановить"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LoadingContent>

      <OptionDialog
        option={editing}
        kind={kind}
        onClose={() => setEditing(null)}
        onRefresh={list.reload}
        onSaved={() => {
          const created = editing === "new";
          setEditing(null);
          toast.show(created ? "Значение добавлено" : "Сохранено");
          list.reload();
        }}
      />
      <StatusDialog
        open={status.target !== null}
        title={
          status.to === "archived"
            ? `Убрать «${status.target?.names.ru ?? ""}» в архив?`
            : `Восстановить «${status.target?.names.ru ?? ""}»?`
        }
        confirm={status.to === "archived" ? "В архив" : "Восстановить"}
        onConfirm={status.confirm}
        onClose={status.close}
        busy={status.saver.saving}
        error={<FormError saver={status.saver} onRefresh={list.reload} />}
      >
        <p>
          {status.to === "archived"
            ? "Значение нельзя будет выбрать для новых модификаций и двигателей, а файл импорта с ним получит ошибку строки. Там, где оно уже выбрано, оно остаётся и видно в приложении."
            : "Значение снова можно будет выбрать."}
        </p>
      </StatusDialog>
    </>
  );
}
