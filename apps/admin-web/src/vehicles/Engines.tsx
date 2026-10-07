import type { AdminVehicleEngine, AdminVehicleOptionListResponse } from "@adclub/contracts";
import { auditEntities } from "@adclub/contracts";
import { Button, EmptyState, LoadingContent, SkeletonList, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { navigateTo, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import { EngineDialog } from "./dialogs";
import {
  FormError,
  ListFilters,
  listFiltersOf,
  LoadError,
  MoreButton,
  StatusDialog,
  StatusMark,
  useStatusFlow,
  usePaged,
  VehiclesTabs,
} from "./shared";
import { countText, MODIFICATIONS } from "./vehicle-words";

/**
 * A-CAR-01, engines (TASK-035.B): a list of their own — code and other
 * spellings, fuel, displacement, power and where each is used (how many
 * modifications have it); search by any spelling, fuel and status filters.
 */
export function Engines() {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const filters = listFiltersOf(location.query);
  const fuelId = location.query.get("fuelId") ?? "";
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
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Автомобили</h1>
        <div className="page__tools">
          <Button variant="secondary" size="s" icon="refresh" onClick={list.first.reload}>
            Обновить
          </Button>
          <Button
            size="s"
            icon="plus"
            disabled={!online || !options.data}
            onClick={() => setEditing("new")}
          >
            Новый двигатель
          </Button>
        </div>
      </div>
      <VehiclesTabs active="engines" />
      <ListFilters searchLabel="Код двигателя или другое написание">
        <label className="select">
          <span className="ac-text-caption ac-muted">Топливо</span>
          <select
            value={fuelId}
            onChange={(event) =>
              navigateTo(
                withQuery("/vehicles/engines", {
                  ...Object.fromEntries(location.query),
                  fuelId: event.target.value || undefined,
                }),
                { replace: true },
              )
            }
          >
            <option value="">Любое</option>
            {fuels.map((fuel) => (
              <option key={fuel.id} value={fuel.id}>
                {fuel.names.ru}
              </option>
            ))}
          </select>
        </label>
      </ListFilters>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted" aria-live="polite">
          Всего: {list.total.toLocaleString("ru-RU")}
        </p>
        {list.items.length === 0 ? (
          <EmptyState
            icon="car"
            title={
              filters.q || filters.status || fuelId ? "Ничего не нашлось" : "Двигателей пока нет"
            }
            text={
              filters.q || filters.status || fuelId
                ? "Измените поиск или отборы"
                : "Добавьте двигатель"
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table vehicles-table">
              <thead>
                <tr>
                  <th scope="col">Код</th>
                  <th scope="col">Топливо</th>
                  <th scope="col" className="num">
                    Объём, л
                  </th>
                  <th scope="col" className="num">
                    Мощность, л.с.
                  </th>
                  <th scope="col">Где используется (модификации)</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((engine) => (
                  <tr
                    key={engine.id}
                    className={engine.status === "archived" ? "row--muted" : undefined}
                  >
                    <td>
                      <div className="cell-stack">
                        <span className="ac-text-body-strong">{engine.code}</span>
                        {engine.aliases.length > 0 && (
                          <span className="ac-text-caption ac-muted">
                            {engine.aliases.join(", ")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="ac-text-body-s">
                      {engine.fuel.names.ru}
                      {engine.fuel.status === "archived" && (
                        <span className="warning-text"> · в архиве</span>
                      )}
                    </td>
                    <td className="num">
                      {engine.displacementL === null
                        ? "—"
                        : String(engine.displacementL).replace(".", ",")}
                    </td>
                    <td className="num">{engine.powerHp ?? "—"}</td>
                    <td className="ac-text-body-s">
                      {engine.modificationCount === 0
                        ? "нигде"
                        : countText(engine.modificationCount, MODIFICATIONS)}
                    </td>
                    <td>
                      <StatusMark status={engine.status} />
                    </td>
                    <td className="admin-table__actions">
                      <div className="button-row button-row--end">
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online || !options.data}
                          onClick={() => setEditing(engine)}
                        >
                          Изменить
                        </Button>
                        <Button
                          variant="text"
                          size="s"
                          disabled={!online}
                          onClick={() => status.open(engine)}
                        >
                          {engine.status === "active" ? "В архив" : "Восстановить"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton list={list} />
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
