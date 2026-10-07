import type { AdminVehicleMake, AdminVehicleModel } from "@adclub/contracts";
import { auditEntities } from "@adclub/contracts";
import { Button, EmptyState, LoadingContent, SkeletonList, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { routePaths, useLocation, vehicleMakePath, vehicleModelPath } from "../router";
import { useLoad } from "../use-load";
import { MakeDialog, ModelDialog } from "./dialogs";
import {
  Crumbs,
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
import { countText, GENERATIONS, MODELS } from "./vehicle-words";

const PAGE = 50;

/** «Убрать марку в архив?» — what archiving it does in the app (TASK-035.B). */
function makeArchiveText(make: AdminVehicleMake) {
  return (
    <p>
      Модели марки ({make.activeModelCount}) пропадут из выбора автомобиля в приложении. Их статус
      не меняется: восстановите марку — и они вернутся. Автомобили, уже добавленные в гаражи, и
      записи совместимости остаются.
    </p>
  );
}

/**
 * A-CAR-01, the first level (SCREENS 7.2; TASK-035.B): makes with their
 * spellings and how many models each has; search by any spelling, the
 * status filter in the address, «всего N», pages; create, change, archive
 * and restore.
 */
export function Makes() {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const filters = listFiltersOf(location.query);
  const list = usePaged<AdminVehicleMake>(async (cursor) => {
    const page = await apiClient.listVehicleMakes({ query: { ...filters, limit: PAGE, cursor } });
    return { items: page.makes, total: page.total, nextCursor: page.nextCursor };
  }, JSON.stringify(filters));
  const [editing, setEditing] = useState<AdminVehicleMake | "new" | null>(null);
  const status = useStatusFlow<AdminVehicleMake>(
    auditEntities.vehicleMake,
    async (make, to, version) =>
      (
        await apiClient.setVehicleMakeStatus(
          { makeId: make.id },
          { status: to, expectedVersion: version },
        )
      ).make,
    (make) => {
      list.update(make);
      toast.show(make.status === "archived" ? "Марка в архиве" : "Марка снова активна");
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
          <Button size="s" icon="plus" disabled={!online} onClick={() => setEditing("new")}>
            Новая марка
          </Button>
        </div>
      </div>
      <VehiclesTabs active="makes" />
      <ListFilters searchLabel="Марка или другое написание" />
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
            title={filters.q || filters.status ? "Ничего не нашлось" : "Марок пока нет"}
            text={
              filters.q || filters.status
                ? "Измените поиск или отбор"
                : "Добавьте марку или загрузите файл во вкладке «Импорт»"
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table vehicles-table">
              <thead>
                <tr>
                  <th scope="col">Марка</th>
                  <th scope="col">Модели</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((make) => (
                  <tr
                    key={make.id}
                    className={make.status === "archived" ? "row--muted" : undefined}
                  >
                    <td>
                      <div className="cell-stack">
                        <AppLink href={vehicleMakePath(make.id)}>{make.name}</AppLink>
                        {make.aliases.length > 0 && (
                          <span className="ac-text-caption ac-muted">
                            {make.aliases.join(", ")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="ac-text-body-s">
                      {countText(make.modelCount, MODELS)}
                      {make.activeModelCount !== make.modelCount && (
                        <span className="ac-muted"> · активных {make.activeModelCount}</span>
                      )}
                    </td>
                    <td>
                      <StatusMark status={make.status} />
                    </td>
                    <td className="admin-table__actions">
                      <div className="button-row button-row--end">
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online}
                          onClick={() => setEditing(make)}
                        >
                          Изменить
                        </Button>
                        <Button
                          variant="text"
                          size="s"
                          disabled={!online}
                          onClick={() => status.open(make)}
                        >
                          {make.status === "active" ? "В архив" : "Восстановить"}
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

      <MakeDialog
        make={editing}
        onClose={() => setEditing(null)}
        onRefresh={list.first.reload}
        onSaved={(make) => {
          const created = editing === "new";
          setEditing(null);
          toast.show(created ? "Марка создана" : "Сохранено");
          if (created) list.first.reload();
          else list.update(make);
        }}
      />
      <StatusDialog
        open={status.target !== null}
        title={
          status.to === "archived"
            ? `Убрать марку «${status.target?.name ?? ""}» в архив?`
            : `Восстановить марку «${status.target?.name ?? ""}»?`
        }
        confirm={status.to === "archived" ? "В архив" : "Восстановить"}
        onConfirm={status.confirm}
        onClose={status.close}
        busy={status.saver.saving}
        error={<FormError saver={status.saver} onRefresh={list.first.reload} />}
      >
        {status.target &&
          (status.to === "archived" ? (
            makeArchiveText(status.target)
          ) : (
            <p>Марка и её активные модели снова появятся в выборе автомобиля в приложении.</p>
          ))}
      </StatusDialog>
    </>
  );
}

/**
 * A make with its models (A-CAR-01; TASK-035.B): the make's own card and
 * actions, then its models with their generations count; a model moves to
 * another make from its dialog.
 */
export function MakePage({ makeId }: { makeId: string }) {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const filters = listFiltersOf(location.query);
  const make = useLoad<AdminVehicleMake>(
    async () => (await apiClient.getVehicleMake({ makeId })).make,
    makeId,
  );
  const list = usePaged<AdminVehicleModel>(
    async (cursor) => {
      const page = await apiClient.listVehicleModels({
        query: { ...filters, makeId, limit: PAGE, cursor },
      });
      return { items: page.models, total: page.total, nextCursor: page.nextCursor };
    },
    JSON.stringify({ makeId, ...filters }),
  );
  const [editingMake, setEditingMake] = useState<AdminVehicleMake | null>(null);
  const [editing, setEditing] = useState<AdminVehicleModel | "new" | null>(null);
  const makeStatus = useStatusFlow<AdminVehicleMake>(
    auditEntities.vehicleMake,
    async (entry, to, version) =>
      (
        await apiClient.setVehicleMakeStatus(
          { makeId: entry.id },
          { status: to, expectedVersion: version },
        )
      ).make,
    (saved) => {
      make.replace(saved);
      list.first.reload();
      toast.show(saved.status === "archived" ? "Марка в архиве" : "Марка снова активна");
    },
  );
  const modelStatus = useStatusFlow<AdminVehicleModel>(
    auditEntities.vehicleModel,
    async (model, to, version) =>
      (
        await apiClient.setVehicleModelStatus(
          { modelId: model.id },
          { status: to, expectedVersion: version },
        )
      ).model,
    (model) => {
      list.update(model);
      make.reload();
      toast.show(model.status === "archived" ? "Модель в архиве" : "Модель снова активна");
    },
    (model) => ({ parents: { make: model.make } }),
  );
  const current = make.data;

  return (
    <>
      <Crumbs
        steps={[{ label: "Марки", href: routePaths.vehicles }, { label: current?.name ?? "…" }]}
      />
      <LoadError error={make.error} retry={make.reload} />
      {current && (
        <div className="page__head">
          <div className="cell-stack">
            <h1 className="ac-text-title-l page__title">{current.name}</h1>
            <span className="ac-text-body-s ac-muted">
              {current.aliases.length > 0
                ? `Другие написания: ${current.aliases.join(", ")} · `
                : ""}
              {countText(current.modelCount, MODELS)}
            </span>
          </div>
          <div className="page__tools">
            <StatusMark status={current.status} />
            <Button
              variant="secondary"
              size="s"
              disabled={!online}
              onClick={() => setEditingMake(current)}
            >
              Изменить
            </Button>
            <Button
              variant="text"
              size="s"
              disabled={!online}
              onClick={() => makeStatus.open(current)}
            >
              {current.status === "active" ? "В архив" : "Восстановить"}
            </Button>
          </div>
        </div>
      )}
      {current?.status === "archived" && (
        <p className="ac-text-body-s warning-text">
          Марка в архиве: её модели не видны в приложении. Новые модели появятся после
          восстановления марки.
        </p>
      )}
      <div className="page__head">
        <h2 className="ac-text-heading">Модели</h2>
        <Button
          size="s"
          icon="plus"
          disabled={!online || !current || current.status === "archived"}
          onClick={() => setEditing("new")}
        >
          Новая модель
        </Button>
      </div>
      <ListFilters searchLabel="Модель или другое написание" />
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted" aria-live="polite">
          Всего: {list.total.toLocaleString("ru-RU")}
        </p>
        {list.items.length === 0 ? (
          <EmptyState
            icon="car"
            title={filters.q || filters.status ? "Ничего не нашлось" : "Моделей пока нет"}
            text={
              filters.q || filters.status ? "Измените поиск или отбор" : "Добавьте первую модель"
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table vehicles-table">
              <thead>
                <tr>
                  <th scope="col">Модель</th>
                  <th scope="col">Поколения</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((model) => (
                  <tr
                    key={model.id}
                    className={model.status === "archived" ? "row--muted" : undefined}
                  >
                    <td>
                      <div className="cell-stack">
                        <AppLink href={vehicleModelPath(model.id)}>{model.name}</AppLink>
                        {model.aliases.length > 0 && (
                          <span className="ac-text-caption ac-muted">
                            {model.aliases.join(", ")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="ac-text-body-s">
                      {countText(model.generationCount, GENERATIONS)}
                    </td>
                    <td>
                      <StatusMark
                        status={model.status}
                        hidden={model.status === "active" && !model.visibleToClients}
                      />
                    </td>
                    <td className="admin-table__actions">
                      <div className="button-row button-row--end">
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online}
                          onClick={() => setEditing(model)}
                        >
                          Изменить
                        </Button>
                        <Button
                          variant="text"
                          size="s"
                          disabled={!online}
                          onClick={() => modelStatus.open(model)}
                        >
                          {model.status === "active" ? "В архив" : "Восстановить"}
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

      <MakeDialog
        make={editingMake}
        onClose={() => setEditingMake(null)}
        onRefresh={make.reload}
        onSaved={(saved) => {
          setEditingMake(null);
          make.replace(saved);
          toast.show("Сохранено");
        }}
      />
      {current && (
        <ModelDialog
          model={editing}
          make={current}
          onClose={() => setEditing(null)}
          onRefresh={list.first.reload}
          onSaved={(model) => {
            const created = editing === "new";
            setEditing(null);
            if (model.make.id !== makeId) {
              toast.show(`Модель перенесена к марке ${model.make.name}`);
              list.first.reload();
            } else {
              toast.show(created ? "Модель создана" : "Сохранено");
              if (created) list.first.reload();
              else list.update(model);
            }
            make.reload();
          }}
        />
      )}
      <StatusDialog
        open={makeStatus.target !== null}
        title={
          makeStatus.to === "archived"
            ? `Убрать марку «${makeStatus.target?.name ?? ""}» в архив?`
            : `Восстановить марку «${makeStatus.target?.name ?? ""}»?`
        }
        confirm={makeStatus.to === "archived" ? "В архив" : "Восстановить"}
        onConfirm={makeStatus.confirm}
        onClose={makeStatus.close}
        busy={makeStatus.saver.saving}
        error={<FormError saver={makeStatus.saver} onRefresh={make.reload} />}
      >
        {makeStatus.target &&
          (makeStatus.to === "archived" ? (
            makeArchiveText(makeStatus.target)
          ) : (
            <p>Марка и её активные модели снова появятся в выборе автомобиля в приложении.</p>
          ))}
      </StatusDialog>
      <StatusDialog
        open={modelStatus.target !== null}
        title={
          modelStatus.to === "archived"
            ? `Убрать модель «${modelStatus.target?.name ?? ""}» в архив?`
            : `Восстановить модель «${modelStatus.target?.name ?? ""}»?`
        }
        confirm={modelStatus.to === "archived" ? "В архив" : "Восстановить"}
        onConfirm={modelStatus.confirm}
        onClose={modelStatus.close}
        busy={modelStatus.saver.saving}
        error={<FormError saver={modelStatus.saver} onRefresh={list.first.reload} />}
      >
        {modelStatus.target &&
          (modelStatus.to === "archived" ? (
            <p>
              Модель и её поколения ({modelStatus.target.generationCount}) пропадут из выбора
              автомобиля в приложении. Автомобили, уже добавленные в гаражи, и записи совместимости
              остаются.
            </p>
          ) : (
            <p>Модель снова появится в выборе автомобиля, если марка активна.</p>
          ))}
      </StatusDialog>
    </>
  );
}
