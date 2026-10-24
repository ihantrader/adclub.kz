import type {
  AdminVehicleGeneration,
  AdminVehicleModel,
  AdminVehicleModification,
  AdminVehicleOptionListResponse,
} from "@adclub/contracts";
import { auditEntities } from "@adclub/contracts";
import {
  Banner,
  Button,
  EmptyState,
  LoadingContent,
  SkeletonList,
  TableToolbar,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { Header, RowTitle, rowLink, Table, type Column } from "../layout/layout";
import { useLocation, vehicleGenerationPath, vehicleMakePath, vehicleModelPath } from "../router";
import { useLoad } from "../use-load";
import { GenerationDialog, ModelDialog, ModificationDialog } from "./dialogs";
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
  resetFilters,
  RowActions,
  StatusDialog,
  StatusMark,
  useStatusFlow,
  usePaged,
  VEHICLES_CRUMB,
} from "./shared";
import { countText, engineSpecsText, GENERATIONS, MODIFICATIONS, yearsText } from "./vehicle-words";

const GENERATION_COLUMNS: Column[] = [
  { key: "name", header: "Поколение" },
  { key: "years", header: "Годы", width: 140 },
  { key: "modifications", header: "Модификации", width: 140, numeric: true },
  { key: "actions", header: "Действия", width: 160, actions: true, hiddenHeader: true },
];

const MODIFICATION_COLUMNS: Column[] = [
  { key: "body", header: "Кузов", width: 140 },
  { key: "engine", header: "Двигатель" },
  { key: "transmission", header: "КПП", width: 160 },
  { key: "drive", header: "Привод", width: 120 },
  { key: "years", header: "Годы", width: 110 },
  { key: "actions", header: "Действия", width: 160, actions: true, hiddenHeader: true },
];

/** The empty list of a section: nothing yet, or nothing by the filters (with their reset). */
function EmptyList({ filtered, title, text }: { filtered: boolean; title: string; text: string }) {
  return (
    <EmptyState
      compact
      icon="car"
      title={filtered ? "Ничего не нашлось" : title}
      text={filtered ? "Измените поиск или отбор" : text}
      action={
        filtered ? (
          <Button variant="secondary" size="s" onClick={resetFilters}>
            Сбросить фильтры
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * A model with its generations (A-CAR-01; TASK-035.B, TASK-080): the crumbs
 * «Автомобили › Марки › Geely», the model's name with its status and
 * spellings, «Изменить» (moving to another make too) and «⋯» in the head;
 * then its generations with their years and how many modifications each has.
 */
export function ModelPage({ modelId }: { modelId: string }) {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const filters = listFiltersOf(location.query);
  const filtered = filteredBy(location.query);
  const model = useLoad<AdminVehicleModel>(
    async () => (await apiClient.getVehicleModel({ modelId })).model,
    modelId,
  );
  const list = usePaged<AdminVehicleGeneration>(
    async (cursor) => {
      const page = await apiClient.listVehicleGenerations({
        query: { ...filters, modelId, limit: 50, cursor },
      });
      return { items: page.generations, total: page.total, nextCursor: page.nextCursor };
    },
    JSON.stringify({ modelId, ...filters }),
  );
  const [editingModel, setEditingModel] = useState<AdminVehicleModel | null>(null);
  const [editing, setEditing] = useState<AdminVehicleGeneration | "new" | null>(null);
  const modelStatus = useStatusFlow<AdminVehicleModel>(
    auditEntities.vehicleModel,
    async (entry, to, version) =>
      (
        await apiClient.setVehicleModelStatus(
          { modelId: entry.id },
          { status: to, expectedVersion: version },
        )
      ).model,
    (saved) => {
      model.replace(saved);
      list.first.reload();
      toast.show(saved.status === "archived" ? "Модель в архиве" : "Модель снова активна");
    },
    (entry) => ({ parents: { make: entry.make } }),
  );
  const generationStatus = useStatusFlow<AdminVehicleGeneration>(
    auditEntities.vehicleGeneration,
    async (generation, to, version) =>
      (
        await apiClient.setVehicleGenerationStatus(
          { generationId: generation.id },
          { status: to, expectedVersion: version },
        )
      ).generation,
    (generation) => {
      list.update(generation);
      toast.show(
        generation.status === "archived" ? "Поколение в архиве" : "Поколение снова активно",
      );
    },
    (generation) => ({ parents: { make: generation.make, model: generation.model } }),
  );
  const current = model.data && model.data.id === modelId ? model.data : undefined;

  return (
    <>
      <Header
        crumbs={[
          VEHICLES_CRUMB,
          MAKES_CRUMB,
          ...(current
            ? [{ label: current.make.name, href: vehicleMakePath(current.make.id) }]
            : []),
        ]}
        title={current?.name ?? "Модель"}
        subtitle={
          current && (
            <>
              <StatusMark
                status={current.status}
                hidden={current.status === "active" && !current.visibleToClients}
                active="Активна"
              />
              {current.aliases.length > 0 && (
                <span>Другие написания: {current.aliases.join(", ")}</span>
              )}
              <span>{countText(current.generationCount, GENERATIONS)}</span>
            </>
          )
        }
        actions={
          current && (
            <ObjectActions
              name={`${current.make.name} ${current.name}`}
              status={current.status}
              onEdit={() => setEditingModel(current)}
              onStatus={() => modelStatus.open(current)}
              onReload={() => {
                model.reload();
                list.first.reload();
              }}
            />
          )
        }
      />
      <LoadError error={model.error} retry={model.reload} />
      {current && !current.visibleToClients && (
        <Banner tone="warning">
          {current.make.status === "archived"
            ? `Марка ${current.make.name} в архиве — модель не видна в приложении.`
            : "Модель в архиве — она не видна в приложении."}
        </Banner>
      )}
      <section className="section" aria-labelledby="model-generations">
        <div className="section__head">
          <h2 id="model-generations" className="section__title">
            Поколения
          </h2>
          <Button
            size="s"
            icon="plus"
            disabled={!online || !current || !current.visibleToClients}
            onClick={() => setEditing("new")}
          >
            Новое поколение
          </Button>
        </div>
        <ListFilters searchLabel="Поиск поколений" placeholder="Название поколения" />
        <LoadError error={list.first.error} retry={list.first.reload} />
        <LoadingContent
          ready={list.first.data !== undefined}
          indicator={list.first.indicator}
          label="Загрузка"
          swapKey={list.first.answerKey}
          skeleton={<SkeletonList rows={4} label="Загрузка" />}
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
              <EmptyList
                filtered={filtered}
                title="Поколений пока нет"
                text="Добавьте поколение — без него модель нельзя выбрать в приложении"
              />
            ) : (
              <Table label="Поколения модели" columns={GENERATION_COLUMNS}>
                {list.items.map((generation) => {
                  const link = rowLink(vehicleGenerationPath(generation.id));
                  return (
                    <tr
                      key={generation.id}
                      {...link}
                      className={
                        generation.status === "archived"
                          ? `${link.className} row--muted`
                          : link.className
                      }
                    >
                      <td>
                        <MarkedTitle
                          mark={
                            <StatusMark
                              status={generation.status}
                              hidden={
                                generation.status === "active" && !generation.visibleToClients
                              }
                            />
                          }
                        >
                          <RowTitle href={vehicleGenerationPath(generation.id)}>
                            {generation.name}
                          </RowTitle>
                        </MarkedTitle>
                      </td>
                      <td className="nowrap">
                        {yearsText(generation.yearFrom, generation.yearTo)}
                      </td>
                      <td className="num">
                        {generation.modificationCount.toLocaleString("ru-RU")}
                      </td>
                      <td className="admin-table__actions">
                        <RowActions
                          name={generation.name}
                          status={generation.status}
                          onEdit={() => setEditing(generation)}
                          onStatus={() => generationStatus.open(generation)}
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

      {current && (
        <ModelDialog
          model={editingModel}
          make={current.make}
          onClose={() => setEditingModel(null)}
          onRefresh={model.reload}
          onSaved={(saved) => {
            setEditingModel(null);
            model.replace(saved);
            toast.show(
              saved.make.id !== current.make.id
                ? `Модель перенесена к марке ${saved.make.name}`
                : "Сохранено",
            );
          }}
        />
      )}
      {current && (
        <GenerationDialog
          generation={editing}
          model={current}
          onClose={() => setEditing(null)}
          onRefresh={list.first.reload}
          onSaved={(generation) => {
            const created = editing === "new";
            setEditing(null);
            toast.show(created ? "Поколение создано" : "Сохранено");
            if (created) list.first.reload();
            else list.update(generation);
          }}
        />
      )}
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
        error={<FormError saver={modelStatus.saver} onRefresh={model.reload} />}
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
      <StatusDialog
        open={generationStatus.target !== null}
        title={
          generationStatus.to === "archived"
            ? `Убрать поколение «${generationStatus.target?.name ?? ""}» в архив?`
            : `Восстановить поколение «${generationStatus.target?.name ?? ""}»?`
        }
        confirm={generationStatus.to === "archived" ? "В архив" : "Восстановить"}
        onConfirm={generationStatus.confirm}
        onClose={generationStatus.close}
        busy={generationStatus.saver.saving}
        error={<FormError saver={generationStatus.saver} onRefresh={list.first.reload} />}
      >
        {generationStatus.target &&
          (generationStatus.to === "archived" ? (
            <p>
              Поколение и его модификации ({generationStatus.target.modificationCount}) пропадут из
              выбора автомобиля в приложении. Автомобили, уже добавленные в гаражи, остаются.
            </p>
          ) : (
            <p>Поколение снова появится в выборе автомобиля.</p>
          ))}
      </StatusDialog>
    </>
  );
}

/**
 * A generation with its modifications (A-CAR-01; TASK-035.B, TASK-080):
 * the crumbs «Автомобили › Марки › Geely › Coolray», the generation's name
 * with its years and status; then the section «Модификации» — its status
 * chips under its title — body, engine, gearbox, drive, years within the
 * generation's (the market is the server's and the import file's — not
 * shown, TASK-035.C). An archived engine or option is shown marked and is
 * never lost by an edit.
 */
export function GenerationPage({ generationId }: { generationId: string }) {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const statusFilter = listFiltersOf(location.query).status;
  const filtered = statusFilter !== undefined;
  const highlight = location.query.get("highlight");
  const generation = useLoad<AdminVehicleGeneration>(
    async () => (await apiClient.getVehicleGeneration({ generationId })).generation,
    generationId,
  );
  const options = useLoad<AdminVehicleOptionListResponse>(
    () => apiClient.listVehicleOptions(),
    "options",
  );
  const list = usePaged<AdminVehicleModification>(async (cursor) => {
    const page = await apiClient.listVehicleModifications({
      query: { generationId, status: statusFilter, limit: 100, cursor },
    });
    return { items: page.modifications, total: page.total, nextCursor: page.nextCursor };
  }, JSON.stringify({ generationId, statusFilter }));
  const [editingGeneration, setEditingGeneration] = useState<AdminVehicleGeneration | null>(null);
  const [editing, setEditing] = useState<AdminVehicleModification | "new" | null>(null);
  const current =
    generation.data && generation.data.id === generationId ? generation.data : undefined;
  const generationStatus = useStatusFlow<AdminVehicleGeneration>(
    auditEntities.vehicleGeneration,
    async (entry, to, version) =>
      (
        await apiClient.setVehicleGenerationStatus(
          { generationId: entry.id },
          { status: to, expectedVersion: version },
        )
      ).generation,
    (saved) => {
      generation.replace(saved);
      list.first.reload();
      toast.show(saved.status === "archived" ? "Поколение в архиве" : "Поколение снова активно");
    },
    (entry) => ({ parents: { make: entry.make, model: entry.model } }),
  );
  const modificationStatus = useStatusFlow<AdminVehicleModification>(
    auditEntities.vehicleModification,
    async (modification, to, version) =>
      (
        await apiClient.setVehicleModificationStatus(
          { modificationId: modification.id },
          { status: to, expectedVersion: version },
        )
      ).modification,
    (modification) => {
      list.update(modification);
      generation.reload();
      toast.show(
        modification.status === "archived" ? "Модификация в архиве" : "Модификация снова активна",
      );
    },
    (modification) => ({
      parents: {
        make: modification.make,
        model: modification.model,
        generation: modification.generation,
      },
    }),
  );
  const describe = (modification: AdminVehicleModification) =>
    [
      modification.bodyType.names.ru,
      modification.engine.code,
      modification.transmissionType.names.ru,
      modification.driveType.names.ru,
      yearsText(modification.yearFrom, modification.yearTo),
    ].join(" · ");

  return (
    <>
      <Header
        crumbs={[
          VEHICLES_CRUMB,
          MAKES_CRUMB,
          ...(current
            ? [
                { label: current.make.name, href: vehicleMakePath(current.make.id) },
                { label: current.model.name, href: vehicleModelPath(current.model.id) },
              ]
            : []),
        ]}
        title={current?.name ?? "Поколение"}
        subtitle={
          current && (
            <>
              <StatusMark
                status={current.status}
                hidden={current.status === "active" && !current.visibleToClients}
                active="Активно"
              />
              <span>{yearsText(current.yearFrom, current.yearTo)}</span>
              <span>{countText(current.modificationCount, MODIFICATIONS)}</span>
            </>
          )
        }
        actions={
          current && (
            <ObjectActions
              name={`${current.make.name} ${current.model.name} ${current.name}`}
              status={current.status}
              onEdit={() => setEditingGeneration(current)}
              onStatus={() => generationStatus.open(current)}
              onReload={() => {
                generation.reload();
                list.first.reload();
              }}
            />
          )
        }
      />
      <LoadError error={generation.error} retry={generation.reload} />
      {current && !current.visibleToClients && (
        <Banner tone="warning">
          Поколение не видно в приложении: в архиве оно само или то, что выше (модель, марка).
        </Banner>
      )}
      <section className="section" aria-labelledby="generation-modifications">
        <div className="section__head">
          <div className="cell-stack">
            <h2 id="generation-modifications" className="section__title">
              Модификации
            </h2>
            <p className="section__note">Изменения видны в приложении не позже чем через минуту.</p>
          </div>
          <Button
            size="s"
            icon="plus"
            disabled={!online || !current || !current.visibleToClients || !options.data}
            onClick={() => setEditing("new")}
          >
            Новая модификация
          </Button>
        </div>
        <ListFilters searchLabel="Поиск модификаций" withSearch={false} />
        <LoadError error={list.first.error} retry={list.first.reload} />
        <LoadingContent
          ready={list.first.data !== undefined}
          indicator={list.first.indicator}
          label="Загрузка"
          swapKey={list.first.answerKey}
          skeleton={<SkeletonList rows={4} label="Загрузка" />}
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
              <EmptyList
                filtered={filtered}
                title="Модификаций пока нет"
                text="Без модификаций поколение выбирается в приложении только «Сохранить так»"
              />
            ) : (
              <Table label="Модификации поколения" columns={MODIFICATION_COLUMNS}>
                {list.items.map((modification) => (
                  <tr
                    key={modification.id}
                    className={
                      modification.id === highlight
                        ? "row--highlight"
                        : modification.status === "archived"
                          ? "row--muted"
                          : undefined
                    }
                  >
                    <td>
                      <span className="cell-stack">
                        <OptionName option={modification.bodyType} />
                        <StatusMark
                          status={modification.status}
                          hidden={
                            modification.status === "active" && !modification.visibleToClients
                          }
                        />
                      </span>
                    </td>
                    <td>
                      <span className="row-title">
                        <span className="vehicles-engine">
                          {modification.engine.code}
                          {modification.engine.status === "archived" && (
                            <StatusMark status="archived" />
                          )}
                        </span>
                        <span className="row-title__sub">
                          {[engineSpecsText(modification.engine), modification.engine.fuel.names.ru]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </td>
                    <td>
                      <OptionName option={modification.transmissionType} />
                    </td>
                    <td>
                      <OptionName option={modification.driveType} />
                    </td>
                    <td className="nowrap">
                      <span className="cell-stack">
                        <span>{yearsText(modification.yearFrom, modification.yearTo)}</span>
                        {modification.source === "import" && (
                          <TypeMark icon="upload">импорт</TypeMark>
                        )}
                      </span>
                    </td>
                    <td className="admin-table__actions">
                      <RowActions
                        name={describe(modification)}
                        status={modification.status}
                        editDisabled={!options.data}
                        onEdit={() => setEditing(modification)}
                        onStatus={() => modificationStatus.open(modification)}
                      />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
            <MoreButton list={list} />
          </div>
        </LoadingContent>
      </section>

      {current && (
        <GenerationDialog
          generation={editingGeneration}
          model={{ ...current.model, make: current.make }}
          onClose={() => setEditingGeneration(null)}
          onRefresh={generation.reload}
          onSaved={(saved) => {
            setEditingGeneration(null);
            generation.replace(saved);
            toast.show("Сохранено");
          }}
        />
      )}
      {current && options.data && (
        <ModificationDialog
          modification={editing}
          generation={current}
          options={options.data.options}
          onClose={() => setEditing(null)}
          onRefresh={list.first.reload}
          onSaved={(modification) => {
            const created = editing === "new";
            setEditing(null);
            toast.show(created ? "Модификация создана" : "Сохранено");
            if (created || modification.generation.id !== generationId) list.first.reload();
            else list.update(modification);
            generation.reload();
          }}
        />
      )}
      <StatusDialog
        open={generationStatus.target !== null}
        title={
          generationStatus.to === "archived"
            ? `Убрать поколение «${generationStatus.target?.name ?? ""}» в архив?`
            : `Восстановить поколение «${generationStatus.target?.name ?? ""}»?`
        }
        confirm={generationStatus.to === "archived" ? "В архив" : "Восстановить"}
        onConfirm={generationStatus.confirm}
        onClose={generationStatus.close}
        busy={generationStatus.saver.saving}
        error={<FormError saver={generationStatus.saver} onRefresh={generation.reload} />}
      >
        {generationStatus.target &&
          (generationStatus.to === "archived" ? (
            <p>
              Поколение и его модификации ({generationStatus.target.modificationCount}) пропадут из
              выбора автомобиля в приложении. Автомобили, уже добавленные в гаражи, остаются.
            </p>
          ) : (
            <p>Поколение снова появится в выборе автомобиля.</p>
          ))}
      </StatusDialog>
      <StatusDialog
        open={modificationStatus.target !== null}
        title={
          modificationStatus.to === "archived"
            ? "Убрать модификацию в архив?"
            : "Восстановить модификацию?"
        }
        confirm={modificationStatus.to === "archived" ? "В архив" : "Восстановить"}
        onConfirm={modificationStatus.confirm}
        onClose={modificationStatus.close}
        busy={modificationStatus.saver.saving}
        error={<FormError saver={modificationStatus.saver} onRefresh={list.first.reload} />}
      >
        {modificationStatus.target && (
          <>
            <p className="ac-text-body-strong">{describe(modificationStatus.target)}</p>
            <p>
              {modificationStatus.to === "archived"
                ? "Модификация пропадёт из выбора автомобиля в приложении. Автомобили, уже добавленные в гаражи, остаются."
                : "Модификация снова появится в выборе автомобиля."}
            </p>
          </>
        )}
      </StatusDialog>
    </>
  );
}

/** A reference list option by its Russian name, marked when archived. */
function OptionName({
  option,
}: {
  option: { names: { ru: string }; status: "active" | "archived" };
}) {
  return (
    <span className="cell-stack">
      <span>{option.names.ru}</span>
      {option.status === "archived" && <StatusMark status="archived" />}
    </span>
  );
}
