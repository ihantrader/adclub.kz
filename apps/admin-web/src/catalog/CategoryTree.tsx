import {
  categoryIcons,
  type AdminCategory,
  type AdminCategoryNode,
  type AdminCategoryTreeResponse,
  type CategoryIcon,
  type CategoryKind,
  type CategoryStatus,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  Segments,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import { AttributesPanel } from "./AttributesPanel";
import {
  CATEGORY_STATUS_TEXT,
  catalogErrorText,
  conflictText,
  errorField,
  isConflict,
} from "./catalog-words";
import { suggestCode } from "./codes";
import { itemsLink } from "./item-filters";
import { categoryOrderBody } from "./order";
import { AppLink, CatalogTabs, CategoryGlyph, TextsLine, whoChanged } from "./shared";
import { ruText } from "./values";

const KINDS = [
  { value: "goods", label: "Товары" },
  { value: "services", label: "Услуги" },
] as const;

type Editing =
  | { mode: "create"; kind: CategoryKind; parent: AdminCategoryNode | null }
  | { mode: "edit"; categoryId: string };

/**
 * A-CAT-01 «Категории» and A-CAT-02 «Характеристики» (SCREENS 7.2; TASK-035):
 * the tree of two levels — goods and services apart — with names in three
 * languages and where each came from, the icon, «Совместимость обязательна»
 * and the status; on a subcategory, its attributes and their options. Every
 * order goes with the order it was made from (I151), every change with the
 * version; a colleague's change meanwhile comes back as «Эти данные только
 * что изменил {кто}», and what was typed stays.
 */
export function CategoryTree() {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const query = location.query;
  const kind: CategoryKind = query.get("kind") === "services" ? "services" : "goods";
  const selectedId = query.get("node");
  const attributeId = query.get("attribute");
  const optionId = query.get("option");
  const tree = useLoad<AdminCategoryTreeResponse>(() => apiClient.listAdminCategories(), "tree");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [changing, setChanging] = useState<{ category: AdminCategory; to: CategoryStatus } | null>(
    null,
  );

  // From the journal: an attribute or an option opens the tree on its subcategory.
  useEffect(() => {
    if (selectedId || (!attributeId && !optionId)) return;
    let cancelled = false;
    apiClient
      .locateCatalogEntry({
        query: optionId ? { optionId } : { attributeId: attributeId ?? undefined },
      })
      .then(
        (place) => {
          if (cancelled) return;
          navigateTo(
            withQuery(routePaths.catalog, {
              node: place.categoryId,
              attribute: place.attributeId,
              option: place.optionId,
            }),
            { replace: true },
          );
        },
        () => {
          if (!cancelled) setError("Характеристика не найдена — возможно, ссылка устарела");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [selectedId, attributeId, optionId]);

  const all = tree.data?.categories ?? [];
  const find = (id: string | null): { category: AdminCategory; node: AdminCategoryNode } | null => {
    if (!id) return null;
    for (const node of all) {
      if (node.id === id) return { category: node, node };
      const child = node.children.find((entry) => entry.id === id);
      if (child) return { category: child, node };
    }
    return null;
  };
  const selected = find(selectedId);
  // The tree shows the kind of the selected node.
  const shownKind = selected ? selected.category.kind : kind;
  const nodes = all.filter((node) => node.kind === shownKind);

  const select = (id: string | null, nextKind: CategoryKind = shownKind) =>
    navigateTo(
      withQuery(routePaths.catalog, { kind: nextKind === "goods" ? null : nextKind, node: id }),
      {
        replace: true,
      },
    );

  const fail = async (thrown: unknown, entityType: string, entityId: string) => {
    if (isConflict(thrown)) {
      setError(conflictText(await whoChanged(entityType, entityId)));
      tree.reload();
    } else {
      setError(catalogErrorText(thrown));
    }
  };

  const move = async (parent: AdminCategoryNode | null, index: number, by: -1 | 1) => {
    const siblings = parent ? parent.children : nodes;
    const body = categoryOrderBody(parent?.id ?? null, shownKind, siblings, index, by);
    if (!body) return;
    setError(null);
    try {
      tree.replace(await apiClient.reorderCategories(body));
    } catch (thrown) {
      await fail(thrown, "catalog_category", parent?.id ?? shownKind);
    }
  };

  const setStatus = async (category: AdminCategory, status: CategoryStatus) => {
    setError(null);
    try {
      await apiClient.setCategoryStatus(
        { categoryId: category.id },
        { status, expectedVersion: category.version },
      );
      toast.show(`Статус: ${CATEGORY_STATUS_TEXT[status].toLowerCase()}`);
      tree.reload();
    } catch (thrown) {
      await fail(thrown, "catalog_category", category.id);
    } finally {
      setChanging(null);
    }
  };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Справочник</h1>
        <div className="page__tools">
          <Button variant="secondary" size="s" icon="refresh" onClick={tree.reload}>
            Обновить
          </Button>
          <Button
            size="s"
            icon="plus"
            disabled={!online}
            onClick={() => setEditing({ mode: "create", kind: shownKind, parent: null })}
          >
            Добавить узел
          </Button>
        </div>
      </div>
      <CatalogTabs active="tree" />
      {error && (
        <Banner
          tone="warning"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() => {
                setError(null);
                tree.reload();
              }}
            >
              Обновить
            </Button>
          }
        >
          {error}
        </Banner>
      )}
      {tree.error !== undefined && <Banner tone="danger">{loadErrorText(tree.error)}</Banner>}

      <LoadingContent
        ready={tree.data !== undefined}
        indicator={tree.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <div className="catalog-layout">
          <aside className="catalog-tree" aria-label="Дерево категорий">
            <Segments<CategoryKind>
              label="Вид"
              options={KINDS}
              value={shownKind}
              onChange={(next) => select(null, next)}
            />
            {nodes.length === 0 ? (
              <p className="ac-text-body-s ac-muted">Узлов пока нет</p>
            ) : (
              <ol className="tree-list">
                {nodes.map((node, index) => (
                  <li key={node.id}>
                    <TreeRow
                      category={node}
                      selected={node.id === selectedId}
                      first={index === 0}
                      last={index === nodes.length - 1}
                      online={online}
                      onSelect={() => select(node.id)}
                      onMove={(by) => move(null, index, by)}
                    />
                    {node.children.length > 0 && (
                      <ol className="tree-list tree-list--children">
                        {node.children.map((child, childIndex) => (
                          <li key={child.id}>
                            <TreeRow
                              category={child}
                              selected={child.id === selectedId}
                              first={childIndex === 0}
                              last={childIndex === node.children.length - 1}
                              online={online}
                              onSelect={() => select(child.id)}
                              onMove={(by) => move(node, childIndex, by)}
                            />
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </aside>

          <section className="catalog-detail" aria-label="Выбранный узел">
            {selected ? (
              <CategoryDetail
                key={selected.category.id}
                category={selected.category}
                node={selected.node}
                online={online}
                highlightAttributeId={attributeId}
                highlightOptionId={optionId}
                onEdit={() => setEditing({ mode: "edit", categoryId: selected.category.id })}
                onAddChild={() =>
                  setEditing({ mode: "create", kind: selected.node.kind, parent: selected.node })
                }
                onStatus={(to) => setChanging({ category: selected.category, to })}
              />
            ) : (
              <EmptyState
                icon="category"
                title="Выберите узел или подкатегорию"
                text="Слева — дерево. У подкатегории здесь появятся её характеристики, варианты и позиции."
              />
            )}
          </section>
        </div>
      </LoadingContent>

      <CategoryDialog
        editing={editing}
        tree={all}
        current={editing?.mode === "edit" ? (find(editing.categoryId)?.category ?? null) : null}
        onReload={tree.reload}
        onCancel={() => setEditing(null)}
        onSaved={(category) => {
          setEditing(null);
          toast.show("Сохранено");
          tree.reload();
          select(category.id, category.kind);
        }}
      />

      <Dialog
        open={changing !== null}
        onClose={() => setChanging(null)}
        title="Изменить статус?"
        actions={
          <>
            <Button onClick={() => changing && setStatus(changing.category, changing.to)}>
              {changing ? statusAction(changing.category.status, changing.to) : "Изменить"}
            </Button>
            <Button variant="secondary" onClick={() => setChanging(null)}>
              Отмена
            </Button>
          </>
        }
      >
        {changing && (
          <div className="dialog-stack">
            <div className="was-now">
              <span className="was-now__line">
                <span className="ac-muted">«{ruText(changing.category.names)}»:</span>
                <span className="was-now__value">
                  {CATEGORY_STATUS_TEXT[changing.category.status]}
                </span>
                →
                <span className="was-now__value was-now__value--new">
                  {CATEGORY_STATUS_TEXT[changing.to]}
                </span>
              </span>
            </div>
            <p className="ac-text-body-s">{statusEffect(changing.category, changing.to)}</p>
          </div>
        )}
      </Dialog>
    </>
  );
}

function statusAction(from: CategoryStatus, to: CategoryStatus): string {
  if (to === "hidden") return "Скрыть";
  if (to === "archived") return "В архив";
  return from === "archived" ? "Восстановить" : "Показать";
}

function statusEffect(category: AdminCategory, to: CategoryStatus): string {
  const children = category.level === 1 ? " и его подкатегории" : "";
  if (to === "hidden") {
    return `Клиенты перестанут видеть узел${children}. Позиции, характеристики и предложения сохранятся; вернуть можно кнопкой «Показать».`;
  }
  if (to === "archived") {
    return `Узел${children} уйдёт из каталога клиентов и из выбора для новых позиций. Ничего не удаляется: вернуть можно кнопкой «Восстановить».`;
  }
  return "Узел снова будет виден клиентам (если активен и его родитель).";
}

function TreeRow({
  category,
  selected,
  first,
  last,
  online,
  onSelect,
  onMove,
}: {
  category: AdminCategory;
  selected: boolean;
  first: boolean;
  last: boolean;
  online: boolean;
  onSelect: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const name = ruText(category.names);
  return (
    <div
      className={[
        "tree-row",
        selected ? "tree-row--on" : "",
        category.status !== "active" ? "tree-row--muted" : "",
      ].join(" ")}
    >
      <button
        type="button"
        className="tree-row__name"
        onClick={onSelect}
        title={name}
        aria-current={selected ? "true" : undefined}
      >
        <CategoryGlyph icon={category.icon} />
        <span className="clamp">{name}</span>
        {category.status !== "active" && (
          <span className="origin-tag">{CATEGORY_STATUS_TEXT[category.status].toLowerCase()}</span>
        )}
      </button>
      <span className="tree-row__order">
        <IconButton
          icon="arrowLeft"
          className="arrow-up"
          label={`Выше: ${name}`}
          disabled={!online || first}
          onClick={() => onMove(-1)}
        />
        <IconButton
          icon="arrowLeft"
          className="arrow-down"
          label={`Ниже: ${name}`}
          disabled={!online || last}
          onClick={() => onMove(1)}
        />
      </span>
    </div>
  );
}

function CategoryDetail({
  category,
  node,
  online,
  highlightAttributeId,
  highlightOptionId,
  onEdit,
  onAddChild,
  onStatus,
}: {
  category: AdminCategory;
  node: AdminCategoryNode;
  online: boolean;
  highlightAttributeId: string | null;
  highlightOptionId: string | null;
  onEdit: () => void;
  onAddChild: () => void;
  onStatus: (to: CategoryStatus) => void;
}) {
  const isNode = category.level === 1;
  return (
    <div className="detail-stack">
      <div className="detail-head">
        <span className="detail-head__glyph">
          <CategoryGlyph icon={category.icon} size={28} />
        </span>
        <div className="cell-stack">
          <h2 className="ac-text-title page__title">{ruText(category.names)}</h2>
          <TextsLine texts={category.names} />
          <span className="ac-text-caption ac-muted">
            <code>{category.code}</code> ·{" "}
            {isNode ? "узел" : `подкатегория узла «${ruText(node.names)}»`} ·{" "}
            {CATEGORY_STATUS_TEXT[category.status]}
            {category.visibleToClients ? " · видна клиентам" : " · клиенты не видят"}
            {!isNode && category.kind === "goods"
              ? category.compatibilityRequired
                ? " · совместимость обязательна"
                : " · совместимость не обязательна"
              : ""}
          </span>
        </div>
      </div>
      <div className="button-row">
        <Button variant="secondary" size="s" disabled={!online} onClick={onEdit}>
          Изменить
        </Button>
        {isNode && (
          <Button variant="secondary" size="s" icon="plus" disabled={!online} onClick={onAddChild}>
            Добавить подкатегорию
          </Button>
        )}
        {category.status === "active" && (
          <Button variant="text" size="s" disabled={!online} onClick={() => onStatus("hidden")}>
            Скрыть
          </Button>
        )}
        {category.status === "hidden" && (
          <Button variant="text" size="s" disabled={!online} onClick={() => onStatus("active")}>
            Показать
          </Button>
        )}
        {category.status !== "archived" ? (
          <Button variant="text" size="s" disabled={!online} onClick={() => onStatus("archived")}>
            В архив
          </Button>
        ) : (
          <Button variant="text" size="s" disabled={!online} onClick={() => onStatus("active")}>
            Восстановить
          </Button>
        )}
        {!isNode && (
          <AppLink href={itemsLink({ categoryId: category.id })}>Позиции подкатегории</AppLink>
        )}
      </div>
      {isNode ? (
        <p className="ac-text-body-s ac-muted">
          Характеристики и позиции бывают только у подкатегорий. Выберите подкатегорию в дереве.
        </p>
      ) : (
        <AttributesPanel
          category={category}
          highlightAttributeId={highlightAttributeId}
          highlightOptionId={highlightOptionId}
        />
      )}
    </div>
  );
}

type Names = { ru: string; kk: string; en: string };

function CategoryDialog({
  editing,
  tree,
  current,
  onReload,
  onCancel,
  onSaved,
}: {
  editing: Editing | null;
  tree: readonly AdminCategoryNode[];
  /** The category being edited as the tree has it now (its version after a reload). */
  current: AdminCategory | null;
  onReload: () => void;
  onCancel: () => void;
  onSaved: (category: AdminCategory) => void;
}) {
  const [shown, setShown] = useState<Editing | null>(null);
  // The category as the dialog opened it: only what was changed against it
  // is sent, so a colleague's change read after «Обновить данные» stays.
  const [opened, setOpened] = useState<AdminCategory | null>(null);
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [names, setNames] = useState<Names>({ ru: "", kk: "", en: "" });
  const [icon, setIcon] = useState<CategoryIcon | null>(null);
  const [compatibility, setCompatibility] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const [error, setError] = useState<{
    text: string;
    field: string | null;
    conflict: boolean;
  } | null>(null);
  // A new opening of the dialog (not a reload of the tree) fills it anew.
  if (editing !== shown) {
    setShown(editing);
    setError(null);
    setCodeTouched(false);
    setCode("");
    setOpened(editing?.mode === "edit" ? current : null);
    if (editing?.mode === "edit" && current) {
      setNames({
        ru: current.names.ru?.text ?? "",
        kk: current.names.kk?.text ?? "",
        en: current.names.en?.text ?? "",
      });
      setIcon(current.icon);
      setCompatibility(current.compatibilityRequired);
      setParentId(current.parentId);
    } else {
      setNames({ ru: "", kk: "", en: "" });
      setIcon(null);
      setCompatibility(false);
      setParentId(editing?.mode === "create" ? (editing.parent?.id ?? null) : null);
    }
  }

  const kind = editing?.mode === "create" ? editing.kind : (current?.kind ?? "goods");
  const isSubcategory =
    editing?.mode === "create" ? editing.parent !== null : (current?.level ?? 1) === 2;
  const shownCode = codeTouched ? code : suggestCode(names.ru);

  const submit = async () => {
    if (!editing) return;
    if (!names.ru.trim()) {
      setError({ text: "Русское название обязательно", field: "names.ru", conflict: false });
      return;
    }
    const optional = (value: string) => (value.trim() ? value.trim() : null);
    try {
      if (editing.mode === "create") {
        const created = await apiClient.createCategory({
          code: shownCode,
          kind,
          parentId: editing.parent?.id ?? null,
          names: { ru: names.ru.trim(), kk: optional(names.kk), en: optional(names.en) },
          icon,
          ...(isSubcategory && kind === "goods" ? { compatibilityRequired: compatibility } : {}),
        });
        onSaved(created.category);
      } else if (current && opened) {
        const before = {
          ru: opened.names.ru?.text ?? "",
          kk: opened.names.kk?.text ?? "",
          en: opened.names.en?.text ?? "",
        };
        const nameChanges: { ru?: string; kk?: string | null; en?: string | null } = {};
        if (names.ru.trim() !== before.ru) nameChanges.ru = names.ru.trim();
        if (names.kk.trim() !== before.kk) nameChanges.kk = optional(names.kk);
        if (names.en.trim() !== before.en) nameChanges.en = optional(names.en);
        const updated = await apiClient.updateCategory(
          { categoryId: current.id },
          {
            // The version of the category now: after «Обновить данные» the
            // administrator saves over what they have seen.
            expectedVersion: current.version,
            ...(Object.keys(nameChanges).length > 0 ? { names: nameChanges } : {}),
            ...(icon !== opened.icon ? { icon } : {}),
            ...(isSubcategory && kind === "goods" && compatibility !== opened.compatibilityRequired
              ? { compatibilityRequired: compatibility }
              : {}),
            ...(isSubcategory && parentId !== opened.parentId ? { parentId } : {}),
          },
        );
        onSaved(updated.category);
      }
    } catch (thrown) {
      if (isConflict(thrown)) {
        const who = current ? await whoChanged("catalog_category", current.id) : null;
        setError({ text: conflictText(who), field: null, conflict: true });
      } else {
        setError({ text: catalogErrorText(thrown), field: errorField(thrown), conflict: false });
      }
    }
  };

  const fieldError = (field: string) => (error?.field === field ? error.text : undefined);
  const nodesOfKind = tree.filter((node) => node.kind === kind);

  return (
    <Dialog
      open={editing !== null}
      onClose={onCancel}
      title={
        editing?.mode === "create"
          ? editing.parent
            ? `Новая подкатегория в «${ruText(editing.parent.names)}»`
            : kind === "goods"
              ? "Новый узел товаров"
              : "Новый узел услуг"
          : "Изменить категорию"
      }
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
        {editing?.mode === "create" && (
          <TextField
            label="Код"
            value={shownCode}
            onChange={(value) => {
              setCodeTouched(true);
              setCode(value);
            }}
            hint="Латиницей, не меняется после создания"
            error={fieldError("code")}
            autoComplete="off"
          />
        )}
        <TextField
          label="Русский"
          value={names.ru}
          onChange={(ru) => setNames({ ...names, ru })}
          error={fieldError("names.ru")}
          hint="Не длиннее 40 знаков: название плитки в две строки"
        />
        <TextField
          label="Казахский"
          value={names.kk}
          onChange={(kk) => setNames({ ...names, kk })}
          error={fieldError("names.kk")}
          hint={
            editing?.mode === "edit" && current?.names.kk?.origin === "ai"
              ? "Сейчас — перевод ИИ. Исправленный здесь текст станет ручным, ИИ его не затрёт"
              : "Пусто — переведёт ИИ"
          }
        />
        <TextField
          label="Английский"
          value={names.en}
          onChange={(en) => setNames({ ...names, en })}
          error={fieldError("names.en")}
          hint={
            editing?.mode === "edit" && current?.names.en?.origin === "ai"
              ? "Сейчас — перевод ИИ. Исправленный здесь текст станет ручным, ИИ его не затрёт"
              : "Пусто — переведёт ИИ"
          }
        />
        <fieldset className="icon-picker">
          <legend className="ac-text-caption ac-muted">Значок</legend>
          <div className="icon-picker__grid">
            <button
              type="button"
              className={icon === null ? "icon-choice icon-choice--on" : "icon-choice"}
              onClick={() => setIcon(null)}
              aria-pressed={icon === null}
              title="Без значка"
            >
              <span className="ac-text-caption">нет</span>
            </button>
            {categoryIcons.map((code) => (
              <button
                key={code}
                type="button"
                className={icon === code ? "icon-choice icon-choice--on" : "icon-choice"}
                onClick={() => setIcon(code)}
                aria-pressed={icon === code}
                aria-label={code}
                title={code}
              >
                <CategoryGlyph icon={code} size={24} />
              </button>
            ))}
          </div>
        </fieldset>
        {isSubcategory && kind === "goods" && (
          <Checkbox
            label="Совместимость обязательна"
            description="Клиенты видят позиции только для автомобиля, которому они подходят (D-029)"
            checked={compatibility}
            onChange={setCompatibility}
          />
        )}
        {editing?.mode === "edit" && isSubcategory && (
          <label className="select">
            <span className="ac-text-caption ac-muted">Узел (перенос)</span>
            <select value={parentId ?? ""} onChange={(event) => setParentId(event.target.value)}>
              {nodesOfKind.map((node) => (
                <option key={node.id} value={node.id}>
                  {ruText(node.names)}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && !error.field && (
          <p className="dialog-error" role="alert">
            {error.text}{" "}
            {error.conflict && (
              <Button
                variant="text"
                size="s"
                onClick={() => {
                  setError(null);
                  onReload();
                }}
              >
                Обновить данные
              </Button>
            )}
          </p>
        )}
      </div>
    </Dialog>
  );
}
