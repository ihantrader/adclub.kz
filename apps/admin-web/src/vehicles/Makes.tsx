import type { AdminVehicleMake, AdminVehicleModel } from "@adclub/contracts";
import { auditEntities } from "@adclub/contracts";
import {
  Banner,
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
import { Header, RowTitle, rowLink, Table, type Column } from "../layout/layout";
import { useLocation, vehicleMakePath, vehicleModelPath } from "../router";
import { useLoad } from "../use-load";
import { MakeDialog, ModelDialog } from "./dialogs";
import {
  filteredBy,
  FormError,
  ListFilters,
  listFiltersOf,
  LoadError,
  MarkedTitle,
  MAKES_CRUMB,
  MoreButton,
  ObjectActions,
  RefreshButton,
  resetFilters,
  RowActions,
  StatusDialog,
  StatusMark,
  useStatusFlow,
  usePaged,
  VEHICLES_CRUMB,
  vehiclesTabs,
} from "./shared";
import { countText, MODELS } from "./vehicle-words";
import "./vehicles.css";

const PAGE = 50;

const MAKE_COLUMNS: Column[] = [
  { key: "name", header: "Марка" },
  { key: "models", header: "Модели", width: 120, numeric: true },
  { key: "actions", header: "Действия", width: 160, actions: true, hiddenHeader: true },
];

const MODEL_COLUMNS: Column[] = [
  { key: "name", header: "Модель" },
  { key: "generations", header: "Поколения", width: 120, numeric: true },
  { key: "actions", header: "Действия", width: 160, actions: true, hiddenHeader: true },
];

/** «5», or «3 из 5» when some are in the archive. */
function activeOfAll(active: number, all: number): string {
  return active === all
    ? all.toLocaleString("ru-RU")
    : `${active.toLocaleString("ru-RU")} из ${all.toLocaleString("ru-RU")}`;
}

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
 * A-CAR-01, the first level (SCREENS 7.2; TASK-035.B, TASK-080): makes with
 * their spellings and how many models each has; search by any spelling,
 * the status chips in the address, «Всего N», pages; the row opens the make;
 * «Изменить» in the row, the archive and restore in its «⋯».
 */
export function Makes() {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const filters = listFiltersOf(location.query);
  const filtered = filteredBy(location.query);
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
      <Header
        title="Автомобили"
        tabs={vehiclesTabs("makes")}
        actions={
          <>
            <RefreshButton onClick={list.first.reload} />
            <Button size="s" icon="plus" disabled={!online} onClick={() => setEditing("new")}>
              Новая марка
            </Button>
          </>
        }
      />
      <ListFilters searchLabel="Поиск марок" placeholder="Марка или другое написание" />
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
              title={filtered ? "Ничего не нашлось" : "Марок пока нет"}
              text={
                filtered
                  ? "Измените поиск или отбор"
                  : "Добавьте марку или загрузите файл во вкладке «Импорт»"
              }
              action={
                filtered ? (
                  <Button variant="secondary" onClick={resetFilters}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table label="Марки" columns={MAKE_COLUMNS}>
              {list.items.map((make) => {
                const link = rowLink(vehicleMakePath(make.id));
                return (
                  <tr
                    key={make.id}
                    {...link}
                    className={
                      make.status === "archived" ? `${link.className} row--muted` : link.className
                    }
                  >
                    <td>
                      <MarkedTitle mark={<StatusMark status={make.status} />}>
                        <RowTitle
                          href={vehicleMakePath(make.id)}
                          sub={make.aliases.length > 0 ? make.aliases.join(", ") : undefined}
                        >
                          {make.name}
                        </RowTitle>
                      </MarkedTitle>
                    </td>
                    <td
                      className="num"
                      title={
                        make.activeModelCount !== make.modelCount
                          ? `Активных ${make.activeModelCount} из ${countText(make.modelCount, MODELS)}`
                          : undefined
                      }
                    >
                      {activeOfAll(make.activeModelCount, make.modelCount)}
                    </td>
                    <td className="admin-table__actions">
                      <RowActions
                        name={make.name}
                        status={make.status}
                        onEdit={() => setEditing(make)}
                        onStatus={() => status.open(make)}
                      />
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <MoreButton list={list} />
        </div>
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
 * A make with its models (A-CAR-01; TASK-035.B, TASK-080): the crumbs of
 * «Автомобили», the make's name with its status and spellings, «Изменить»
 * and «⋯» in the head; then the section «Модели» with its filters, the
 * models and their generations count; a model moves to another make from
 * its dialog.
 */
export function MakePage({ makeId }: { makeId: string }) {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const filters = listFiltersOf(location.query);
  const filtered = filteredBy(location.query);
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
  const current = make.data && make.data.id === makeId ? make.data : undefined;

  return (
    <>
      <Header
        crumbs={[VEHICLES_CRUMB, MAKES_CRUMB]}
        title={current?.name ?? "Марка"}
        subtitle={
          current && (
            <>
              <StatusMark status={current.status} active="Активна" />
              {current.aliases.length > 0 && (
                <span>Другие написания: {current.aliases.join(", ")}</span>
              )}
              <span>{countText(current.modelCount, MODELS)}</span>
            </>
          )
        }
        actions={
          current && (
            <ObjectActions
              name={current.name}
              status={current.status}
              onEdit={() => setEditingMake(current)}
              onStatus={() => makeStatus.open(current)}
              onReload={() => {
                make.reload();
                list.first.reload();
              }}
            />
          )
        }
      />
      <LoadError error={make.error} retry={make.reload} />
      {current?.status === "archived" && (
        <Banner tone="warning">
          Марка в архиве: её модели не видны в приложении. Новые модели появятся после
          восстановления марки.
        </Banner>
      )}
      <section className="section" aria-labelledby="make-models">
        <div className="section__head">
          <h2 id="make-models" className="section__title">
            Модели
          </h2>
          <Button
            size="s"
            icon="plus"
            disabled={!online || !current || current.status === "archived"}
            onClick={() => setEditing("new")}
          >
            Новая модель
          </Button>
        </div>
        <ListFilters searchLabel="Поиск моделей" placeholder="Модель или другое написание" />
        <LoadError error={list.first.error} retry={list.first.reload} />
        <LoadingContent
          ready={list.first.data !== undefined}
          indicator={list.first.indicator}
          label="Загрузка"
          swapKey={list.first.answerKey}
          skeleton={<SkeletonList rows={5} label="Загрузка" />}
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
                compact
                icon="car"
                title={filtered ? "Ничего не нашлось" : "Моделей пока нет"}
                text={filtered ? "Измените поиск или отбор" : "Добавьте первую модель"}
                action={
                  filtered ? (
                    <Button variant="secondary" size="s" onClick={resetFilters}>
                      Сбросить фильтры
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table label="Модели марки" columns={MODEL_COLUMNS}>
                {list.items.map((model) => {
                  const link = rowLink(vehicleModelPath(model.id));
                  return (
                    <tr
                      key={model.id}
                      {...link}
                      className={
                        model.status === "archived"
                          ? `${link.className} row--muted`
                          : link.className
                      }
                    >
                      <td>
                        <MarkedTitle
                          mark={
                            <StatusMark
                              status={model.status}
                              hidden={model.status === "active" && !model.visibleToClients}
                            />
                          }
                        >
                          <RowTitle
                            href={vehicleModelPath(model.id)}
                            sub={model.aliases.length > 0 ? model.aliases.join(", ") : undefined}
                          >
                            {model.name}
                          </RowTitle>
                        </MarkedTitle>
                      </td>
                      <td className="num">{model.generationCount.toLocaleString("ru-RU")}</td>
                      <td className="admin-table__actions">
                        <RowActions
                          name={model.name}
                          status={model.status}
                          onEdit={() => setEditing(model)}
                          onStatus={() => modelStatus.open(model)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
            <MoreButton list={list} />
          </div>
        </LoadingContent>
      </section>

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
