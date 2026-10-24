import type { AdminVehicleEngine, AdminVehicleOptionListResponse } from "@adclub/contracts";
import { auditEntities } from "@adclub/contracts";
import {
  Button,
  EmptyState,
  LoadingContent,
  SkeletonList,
  TableToolbar,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { FilterSelect } from "../layout/filters";
import { Header, Table, type Column } from "../layout/layout";
import { useLocation } from "../router";
import { useLoad } from "../use-load";
import { EngineDialog } from "./dialogs";
import {
  filteredBy,
  FormError,
  ListFilters,
  listFiltersOf,
  LoadError,
  MarkedTitle,
  MoreButton,
  RefreshButton,
  resetFilters,
  RowActions,
  StatusDialog,
  StatusMark,
  useFilterSetter,
  useStatusFlow,
  usePaged,
  vehiclesTabs,
} from "./shared";
import { displacementText } from "./vehicle-words";

const COLUMNS: Column[] = [
  { key: "code", header: "Код" },
  { key: "fuel", header: "Топливо", width: 130 },
  { key: "displacement", header: "Объём, л", width: 100, numeric: true },
  { key: "power", header: "Мощность, л.с.", width: 130, numeric: true },
  { key: "used", header: "В модификациях", width: 140, numeric: true },
  { key: "actions", header: "Действия", width: 160, actions: true, hiddenHeader: true },
];

/**
 * A-CAR-01, engines (TASK-035.B, TASK-080): a list of their own — code and
 * other spellings, fuel, displacement, power and where each is used (how
 * many modifications have it, «—» — nowhere yet); search by any spelling,
 * the fuel and the status chips.
 */
export function Engines() {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const setFilter = useFilterSetter();
  const filters = listFiltersOf(location.query);
  const fuelId = location.query.get("fuelId") ?? "";
  const filtered = filteredBy(location.query, ["fuelId"]);
  const options = useLoad<AdminVehicleOptionListResponse>(
    () => apiClient.listVehicleOptions(),
    "options",
  );
  const fuels = (options.data?.options ?? []).filter((option) => option.kind === "fuel");
  const list = usePaged<AdminVehicleEngine>(
    async (cursor) => {
      const page = await apiClient.listVehicleEngines({
        query: { ...filters, ...(fuelId ? { fuelId } : {}), limit: 50, cursor },
      });
      return { items: page.engines, total: page.total, nextCursor: page.nextCursor };
    },
    JSON.stringify({ ...filters, fuelId }),
  );
  const [editing, setEditing] = useState<AdminVehicleEngine | "new" | null>(null);
  const status = useStatusFlow<AdminVehicleEngine>(
    auditEntities.vehicleEngine,
    async (engine, to, version) =>
      (
        await apiClient.setVehicleEngineStatus(
          { engineId: engine.id },
          { status: to, expectedVersion: version },
        )
      ).engine,
    (engine) => {
      list.update(engine);
      toast.show(engine.status === "archived" ? "Двигатель в архиве" : "Двигатель снова активен");
    },
  );

  return (
    <>
      <Header
        title="Автомобили"
        tabs={vehiclesTabs("engines")}
        actions={
          <>
            <RefreshButton onClick={list.first.reload} />
            <Button
              size="s"
              icon="plus"
              disabled={!online || !options.data}
              onClick={() => setEditing("new")}
            >
              Новый двигатель
            </Button>
          </>
        }
      />
      <ListFilters searchLabel="Поиск двигателей" placeholder="Код двигателя или другое написание">
        <FilterSelect
          label="Топливо"
          allLabel="Любое"
          value={fuelId}
          options={fuels.map((fuel) => ({ value: fuel.id, label: fuel.names.ru }))}
          onChange={(next) => setFilter({ fuelId: next })}
        />
      </ListFilters>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={list.items.length === 0 ? null : list.total}>
            {filtered && (
              <Button variant="text" size="s" onClick={resetFilters}>
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {list.items.length === 0 ? (
            <EmptyState
              icon="car"
              title={filtered ? "Ничего не нашлось" : "Двигателей пока нет"}
              text={filtered ? "Измените поиск или отборы" : "Добавьте двигатель"}
              action={
                filtered ? (
                  <Button variant="secondary" onClick={resetFilters}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table label="Двигатели" columns={COLUMNS}>
              {list.items.map((engine) => (
                <tr
                  key={engine.id}
                  className={engine.status === "archived" ? "row--muted" : undefined}
                >
                  <td>
                    <MarkedTitle mark={<StatusMark status={engine.status} />}>
                      <span className="row-title">
                        <span className="vehicles-name">{engine.code}</span>
                        {engine.aliases.length > 0 && (
                          <span className="row-title__sub">{engine.aliases.join(", ")}</span>
                        )}
                      </span>
                    </MarkedTitle>
                  </td>
                  <td>
                    <span className="cell-stack">
                      <span>{engine.fuel.names.ru}</span>
                      {engine.fuel.status === "archived" && <StatusMark status="archived" />}
                    </span>
                  </td>
                  <td className="num">{displacementText(engine.displacementL)}</td>
                  <td className="num">{engine.powerHp?.toLocaleString("ru-RU") ?? "—"}</td>
                  <td
                    className="num"
                    title={
                      engine.modificationCount === 0
                        ? "Не выбран ни в одной модификации"
                        : undefined
                    }
                  >
                    {engine.modificationCount === 0
                      ? "—"
                      : engine.modificationCount.toLocaleString("ru-RU")}
                  </td>
                  <td className="admin-table__actions">
                    <RowActions
                      name={engine.code}
                      status={engine.status}
                      editDisabled={!options.data}
                      onEdit={() => setEditing(engine)}
                      onStatus={() => status.open(engine)}
                    />
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>

      {options.data && (
        <EngineDialog
          engine={editing}
          options={options.data.options}
          onClose={() => setEditing(null)}
          onRefresh={list.first.reload}
          onSaved={(engine) => {
            const created = editing === "new";
            setEditing(null);
            toast.show(created ? "Двигатель создан" : "Сохранено");
            if (created) list.first.reload();
            else list.update(engine);
          }}
        />
      )}
      <StatusDialog
        open={status.target !== null}
        title={
          status.to === "archived"
            ? `Убрать двигатель «${status.target?.code ?? ""}» в архив?`
            : `Восстановить двигатель «${status.target?.code ?? ""}»?`
        }
        confirm={status.to === "archived" ? "В архив" : "Восстановить"}
        onConfirm={status.confirm}
        onClose={status.close}
        busy={status.saver.saving}
        error={<FormError saver={status.saver} onRefresh={list.first.reload} />}
      >
        {status.target &&
          (status.to === "archived" ? (
            <p>
              Двигатель нельзя будет выбрать для новых модификаций. В модификациях, где он уже
              выбран ({status.target.modificationCount}), он остаётся и виден в приложении.
            </p>
          ) : (
            <p>Двигатель снова можно будет выбрать для модификаций.</p>
          ))}
      </StatusDialog>
    </>
  );
}
