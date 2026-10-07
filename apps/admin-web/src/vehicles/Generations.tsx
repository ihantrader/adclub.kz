import type {
  AdminVehicleGeneration,
  AdminVehicleModel,
  AdminVehicleModification,
  AdminVehicleOptionListResponse,
} from "@adclub/contracts";
import { auditEntities } from "@adclub/contracts";
import { Button, EmptyState, LoadingContent, SkeletonList, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import {
  navigateTo,
  routePaths,
  useLocation,
  vehicleGenerationPath,
  vehicleMakePath,
  vehicleModelPath,
  withQuery,
} from "../router";
import { engineSpecs } from "../search-select/sources";
import { useLoad } from "../use-load";
import { GenerationDialog, ModelDialog, ModificationDialog } from "./dialogs";
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
} from "./shared";
import { countText, MARKET_TEXT, MODIFICATIONS, yearsText } from "./vehicle-words";

/**
 * A model with its generations (A-CAR-01; TASK-035.B): the model's card —
 * its make, spellings, moving to another make — and its generations with
 * their years and how many modifications each has.
 */
export function ModelPage({ modelId }: { modelId: string }) {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const filters = listFiltersOf(location.query);
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
  const current = model.data;

  return (
    <>
      <Crumbs
        steps={[
          { label: "Марки", href: routePaths.vehicles },
          {
            label: current?.make.name ?? "…",
            href: current ? vehicleMakePath(current.make.id) : undefined,
          },
          { label: current?.name ?? "…" },
        ]}
      />
      <LoadError error={model.error} retry={model.reload} />
      {current && (
        <div className="page__head">
          <div className="cell-stack">
            <h1 className="ac-text-title-l page__title">
              {current.make.name} {current.name}
            </h1>
            <span className="ac-text-body-s ac-muted">
              {current.aliases.length > 0 ? `Другие написания: ${current.aliases.join(", ")}` : ""}
            </span>
          </div>
          <div className="page__tools">
            <StatusMark
              status={current.status}
              hidden={current.status === "active" && !current.visibleToClients}
            />
            <Button
              variant="secondary"
              size="s"
              disabled={!online}
              onClick={() => setEditingModel(current)}
            >
              Изменить
            </Button>
            <Button
              variant="text"
              size="s"
              disabled={!online}
              onClick={() => modelStatus.open(current)}
            >
              {current.status === "active" ? "В архив" : "Восстановить"}
            </Button>
          </div>
        </div>
      )}
      {current && !current.visibleToClients && (
        <p className="ac-text-body-s warning-text">
          {current.make.status === "archived"
            ? `Марка ${current.make.name} в архиве — модель не видна в приложении.`
            : "Модель в архиве — она не видна в приложении."}
        </p>
      )}
      <div className="page__head">
        <h2 className="ac-text-heading">Поколения</h2>
        <Button
          size="s"
          icon="plus"
          disabled={!online || !current || !current.visibleToClients}
          onClick={() => setEditing("new")}
        >
          Новое поколение
        </Button>
      </div>
      <ListFilters searchLabel="Название поколения" />
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted" aria-live="polite">
          Всего: {list.total.toLocaleString("ru-RU")}
        </p>
        {list.items.length === 0 ? (
          <EmptyState
            icon="car"
            title={filters.q || filters.status ? "Ничего не нашлось" : "Поколений пока нет"}
            text={
              filters.q || filters.status
                ? "Измените поиск или отбор"
                : "Добавьте поколение — без него модель нельзя выбрать в приложении"
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table vehicles-table">
              <thead>
                <tr>
                  <th scope="col">Поколение</th>
                  <th scope="col">Годы</th>
                  <th scope="col">Модификации</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((generation) => (
                  <tr
                    key={generation.id}
                    className={generation.status === "archived" ? "row--muted" : undefined}
                  >
                    <td>
                      <AppLink href={vehicleGenerationPath(generation.id)}>
                        {generation.name}
                      </AppLink>
                    </td>
                    <td className="years ac-text-body-s">
                      {yearsText(generation.yearFrom, generation.yearTo)}
                    </td>
                    <td className="ac-text-body-s">
                      {countText(generation.modificationCount, MODIFICATIONS)}
                    </td>
                    <td>
                      <StatusMark
                        status={generation.status}
                        hidden={generation.status === "active" && !generation.visibleToClients}
                      />
                    </td>
                    <td className="admin-table__actions">
                      <div className="button-row button-row--end">
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online}
                          onClick={() => setEditing(generation)}
                        >
                          Изменить
                        </Button>
                        <Button
                          variant="text"
                          size="s"
                          disabled={!online}
                          onClick={() => generationStatus.open(generation)}
                        >
                          {generation.status === "active" ? "В архив" : "Восстановить"}
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
 * A generation with its modifications (A-CAR-01; TASK-035.B): body,
 * engine, gearbox, drive, years within the generation's, market. Dozens of
 * modifications fit a 1024 px table without scrolling sideways; an
 * archived engine or option is shown marked and is never lost by an edit.
 */
export function GenerationPage({ generationId }: { generationId: string }) {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const status = location.query.get("status");
  const highlight = location.query.get("highlight");
  const statusFilter = status === "active" || status === "archived" ? status : undefined;
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
  const current = generation.data;
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
      <Crumbs
        steps={[
          { label: "Марки", href: routePaths.vehicles },
          {
            label: current?.make.name ?? "…",
            href: current ? vehicleMakePath(current.make.id) : undefined,
          },
          {
            label: current?.model.name ?? "…",
            href: current ? vehicleModelPath(current.model.id) : undefined,
          },
          {
            label: current
              ? `${current.name} (${yearsText(current.yearFrom, current.yearTo)})`
              : "…",
          },
        ]}
      />
      <LoadError error={generation.error} retry={generation.reload} />
      {current && (
        <div className="page__head">
          <div className="cell-stack">
            <h1 className="ac-text-title-l page__title">
              {current.make.name} {current.model.name} · {current.name}
            </h1>
            <span className="ac-text-body-s ac-muted">
              {yearsText(current.yearFrom, current.yearTo)} ·{" "}
              {countText(current.modificationCount, MODIFICATIONS)}
            </span>
          </div>
          <div className="page__tools">
            <StatusMark
              status={current.status}
              hidden={current.status === "active" && !current.visibleToClients}
            />
            <Button
              variant="secondary"
              size="s"
              disabled={!online}
              onClick={() => setEditingGeneration(current)}
            >
              Изменить
            </Button>
            <Button
              variant="text"
              size="s"
              disabled={!online}
              onClick={() => generationStatus.open(current)}
            >
              {current.status === "active" ? "В архив" : "Восстановить"}
            </Button>
          </div>
        </div>
      )}
      {current && !current.visibleToClients && (
        <p className="ac-text-body-s warning-text">
          Поколение не видно в приложении: в архиве оно само или то, что выше (модель, марка).
        </p>
      )}
      <div className="page__head">
        <h2 className="ac-text-heading">Модификации</h2>
        <div className="page__tools">
          <label className="select">
            <span className="ac-visually-hidden">Статус</span>
            <select
              value={statusFilter ?? ""}
              onChange={(event) => navigateStatus(event.target.value || undefined, generationId)}
            >
              <option value="">Все</option>
              <option value="active">Активные</option>
              <option value="archived">В архиве</option>
            </select>
          </label>
          <Button
            size="s"
            icon="plus"
            disabled={!online || !current || !current.visibleToClients || !options.data}
            onClick={() => setEditing("new")}
          >
            Новая модификация
          </Button>
        </div>
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted" aria-live="polite">
          Всего: {list.total.toLocaleString("ru-RU")}
        </p>
        {list.items.length === 0 ? (
          <EmptyState
            icon="car"
            title={statusFilter ? "Ничего не нашлось" : "Модификаций пока нет"}
            text={
              statusFilter
                ? "Измените отбор"
                : "Без модификаций поколение выбирается в приложении только «Сохранить так»"
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table vehicles-table">
              <thead>
                <tr>
                  <th scope="col">Кузов</th>
                  <th scope="col">Двигатель</th>
                  <th scope="col">КПП</th>
                  <th scope="col">Привод</th>
                  <th scope="col">Годы</th>
                  <th scope="col">Рынок</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
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
                    <td className="ac-text-body-s">
                      <OptionName option={modification.bodyType} />
                    </td>
                    <td>
                      <div className="cell-stack">
                        <span className="ac-text-body-s">
                          {modification.engine.code}
                          {modification.engine.status === "archived" && (
                            <span className="warning-text"> · в архиве</span>
                          )}
                        </span>
                        <span className="ac-text-caption ac-muted">
                          {[engineSpecs(modification.engine), modification.engine.fuel.names.ru]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                    </td>
                    <td className="ac-text-body-s">
                      <OptionName option={modification.transmissionType} />
                    </td>
                    <td className="ac-text-body-s">
                      <OptionName option={modification.driveType} />
                    </td>
                    <td className="years ac-text-body-s">
                      {yearsText(modification.yearFrom, modification.yearTo)}
                    </td>
                    <td className="ac-text-body-s">
                      {MARKET_TEXT[modification.market]}
                      {modification.source === "import" && (
                        <span className="ac-text-caption ac-muted"> · импорт</span>
                      )}
                    </td>
                    <td>
                      <StatusMark
                        status={modification.status}
                        hidden={modification.status === "active" && !modification.visibleToClients}
                      />
                    </td>
                    <td className="admin-table__actions">
                      <div className="button-row button-row--end">
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online || !options.data}
                          onClick={() => setEditing(modification)}
                        >
                          Изменить
                        </Button>
                        <Button
                          variant="text"
                          size="s"
                          disabled={!online}
                          onClick={() => modificationStatus.open(modification)}
                        >
                          {modification.status === "active" ? "В архив" : "Восстановить"}
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
      <p className="ac-text-caption ac-muted">
        Изменения видны в приложении не позже чем через минуту.{" "}
        <AppLink href={routePaths.vehicleEngines}>Двигатели</AppLink> ·{" "}
        <AppLink href={routePaths.vehicleOptions}>Справочные списки</AppLink>
      </p>

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
    <>
      {option.names.ru}
      {option.status === "archived" && <span className="warning-text"> · в архиве</span>}
    </>
  );
}

function navigateStatus(status: string | undefined, generationId: string): void {
  navigateTo(withQuery(`/vehicles/generations/${generationId}`, { status }), { replace: true });
}
