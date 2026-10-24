import { isApiError } from "@adclub/api-client";
import type {
  AdminVehicleOption,
  AdminVehicleOptionListResponse,
  VehicleOptionKind,
} from "@adclub/contracts";
import { auditActions, auditEntities, vehicleOptionKindSchema } from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  TableToolbar,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { actorText } from "../audit/audit-words";
import { StatusChips } from "../layout/filters";
import { Header, Table, type Column } from "../layout/layout";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import { OptionDialog } from "./dialogs";
import {
  FormError,
  LoadError,
  MarkedTitle,
  RefreshButton,
  RowActions,
  StatusDialog,
  StatusMark,
  useStatusFlow,
  vehiclesTabs,
} from "./shared";
import { conflictText, OPTION_KIND_TEXT, vehicleErrorView } from "./vehicle-words";

const KINDS = vehicleOptionKindSchema.options;

const COLUMNS: Column[] = [
  { key: "name", header: "Русский" },
  { key: "kk", header: "Казахский", width: 150 },
  { key: "en", header: "Английский", width: 150 },
  { key: "actions", header: "Действия", width: 160, actions: true, hiddenHeader: true },
];

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

/** A name a translator hasn't written: «нет» as a warning mark, not a blank. */
function NameOrMissing({ name }: { name: string | null }) {
  if (name) return <span>{name}</span>;
  return (
    <Badge tone="warning" icon="alertTriangle">
      Нет названия
    </Badge>
  );
}

/**
 * A-CAR-01, the reference lists — body, gearbox, drive, fuel (TASK-035.B,
 * TASK-080; ARCHITECTURE 4.24 I215): the list chosen by chips, then its
 * values — the Russian name with its code under it and the arrows of the
 * order next to it (sent with the order they were made from), names in
 * kk/en written by hand (these lists are never translated automatically),
 * «Изменить» and «⋯» with the archive and restore. An option is named in an
 * import file by its code or any of its names.
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
      <Header
        title="Автомобили"
        tabs={vehiclesTabs("options")}
        actions={
          <>
            <RefreshButton onClick={list.reload} />
            <Button size="s" icon="plus" disabled={!online} onClick={() => setEditing("new")}>
              Новое значение
            </Button>
          </>
        }
      />
      <div className="filters__group">
        <StatusChips<VehicleOptionKind>
          label="Список"
          allLabel={null}
          value={kind}
          chips={KINDS.map((entry) => ({ value: entry, label: OPTION_KIND_TEXT[entry] }))}
          onChange={(entry) =>
            navigateTo(withQuery(routePaths.vehicleOptions, { kind: entry ?? kind }), {
              replace: true,
            })
          }
        />
        <p className="section__note">
          Названия на казахском и английском вводятся вручную — автоперевода у этих списков нет.
          Файл импорта называет значение кодом или любым названием.
        </p>
      </div>
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
              Обновить данные
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
        <div className="list-block">
          <TableToolbar total={options.length === 0 ? null : options.length} />
          {options.length === 0 ? (
            <EmptyState
              icon="car"
              title={`Список «${OPTION_KIND_TEXT[kind]}» пуст`}
              text="Добавьте первое значение"
            />
          ) : (
            <Table label={`Список «${OPTION_KIND_TEXT[kind]}»`} columns={COLUMNS}>
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
                    <span className="vehicles-ordered">
                      <span className="vehicles-order" role="group" aria-label="Порядок">
                        <IconButton
                          icon="arrowUp"
                          size={20}
                          label={`Выше: ${option.names.ru}`}
                          disabled={!online || index === 0}
                          onClick={() => move(index, -1)}
                        />
                        <IconButton
                          icon="arrowDown"
                          size={20}
                          label={`Ниже: ${option.names.ru}`}
                          disabled={!online || index === options.length - 1}
                          onClick={() => move(index, 1)}
                        />
                      </span>
                      <MarkedTitle mark={<StatusMark status={option.status} />}>
                        <span className="row-title">
                          <span className="vehicles-name">{option.names.ru}</span>
                          <span className="code-text">{option.code}</span>
                        </span>
                      </MarkedTitle>
                    </span>
                  </td>
                  <td>
                    <NameOrMissing name={option.names.kk} />
                  </td>
                  <td>
                    <NameOrMissing name={option.names.en} />
                  </td>
                  <td className="admin-table__actions">
                    <RowActions
                      name={option.names.ru}
                      status={option.status}
                      onEdit={() => setEditing(option)}
                      onStatus={() => status.open(option)}
                    />
                  </td>
                </tr>
              ))}
            </Table>
          )}
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
