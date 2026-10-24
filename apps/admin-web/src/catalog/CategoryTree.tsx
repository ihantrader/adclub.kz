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
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  LoadingContent,
  MenuButton,
  Segments,
  Select,
  SkeletonList,
  StatusBadge,
  TextField,
  TypeMark,
  useToast,
  type MenuAction,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { AppLink, Header } from "../layout/layout";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import { AttributesPanel } from "./AttributesPanel";
import { NamesLine, OrderArrows } from "./catalog-ui";
import {
  CATEGORY_STATUS_TEXT,
  catalogErrorText,
  conflictText,
  errorField,
  isConflict,
} from "./catalog-words";
import "./catalog.css";
import { suggestCode } from "./codes";
import { itemsLink } from "./item-filters";
import { categoryOrderBody } from "./order";
import { SearchSynonyms } from "./SearchSynonyms";
import { catalogTabs, CategoryGlyph, whoChanged } from "./shared";
import { ruText } from "./values";

const KINDS = [
  { value: "goods", label: "Товары" },
  { value: "services", label: "Услуги" },
] as const;

type Editing =
  | { mode: "create"; kind: CategoryKind; parent: AdminCategoryNode | null }
  | { mode: "edit"; categoryId: string };

/** A refusal over the tree; a colleague's change offers «Обновить данные». */
interface TreeError {
  text: string;
  conflict: boolean;
}

/**
 * A-CAT-01 «Категории» and A-CAT-02 «Характеристики» (SCREENS 7.2; TASK-035,
 * TASK-080): the tree of two levels — goods and services apart — with names
 * in three languages and where each came from, the icon, «Совместимость
 * обязательна» and the status; on a subcategory, its attributes and their
 * options. Every order goes with the order it was made from (I151), every
 * change with the version; a colleague's change meanwhile comes back as
 * «Эти данные только что изменил {кто}», and what was typed stays.
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
  const [error, setError] = useState<TreeError | null>(null);
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
          if (!cancelled) {
            setError({
              text: "Характеристика не найдена — возможно, ссылка устарела",
              conflict: false,
            });
          }
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
      { replace: true },
    );

  const fail = async (thrown: unknown, entityType: string, entityId: string) => {
    if (isConflict(thrown)) {
      setError({ text: conflictText(await whoChanged(entityType, entityId)), conflict: true });
      tree.reload();
    } else {
      setError({ text: catalogErrorText(thrown), conflict: false });
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
      <Header
        title="Справочник"
        tabs={catalogTabs("tree")}
        actions={
          <>
            <IconButton icon="refresh" label="Обновить" size={20} onClick={tree.reload} />
            <Button
              size="s"
              icon="plus"
              disabled={!online}
              onClick={() => setEditing({ mode: "create", kind: shownKind, parent: null })}
            >
              Добавить узел
            </Button>
          </>
        }
      />
      {error && (
        <Banner
          tone="warning"
          action={
            error.conflict ? (
              <Button
                variant="text"
                size="s"
                onClick={() => {
                  setError(null);
                  tree.reload();
                }}
              >
                Обновить данные
              </Button>
            ) : undefined
          }
        >
          {error.text}
        </Banner>
      )}
      {tree.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={tree.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(tree.error)}
        </Banner>
      )}

      <LoadingContent
        ready={tree.data !== undefined}
        indicator={tree.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <div className="catalog-layout">
          <aside className="catalog-tree cat-tree" aria-label="Дерево категорий">
            <Segments<CategoryKind>
              label="Вид"
              options={KINDS}
              value={shownKind}
              onChange={(next) => select(null, next)}
            />
            {nodes.length === 0 ? (
              <EmptyState
                compact
                icon="category"
                title="Узлов пока нет"
                text="Добавьте первый узел кнопкой «Добавить узел»"
              />
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
              <div className="card">
                <EmptyState
                  icon="category"
                  title="Выберите узел или подкатегорию"
                  text="Слева — дерево. У подкатегории здесь появятся её характеристики, варианты и позиции."
                />
              </div>
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
        "cat-tree-row",
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
          <StatusBadge kind="category" status={category.status}>
            {CATEGORY_STATUS_TEXT[category.status]}
          </StatusBadge>
        )}
      </button>
      {selected && (
        <OrderArrows name={name} first={first} last={last} disabled={!online} onMove={onMove} />
      )}
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
  const name = ruText(category.names);
  const statusActions: MenuAction[] = [
    ...(category.status === "active"
      ? [
          {
            key: "hide",
            label: "Скрыть…",
            icon: "lock" as const,
            disabled: !online,
            onSelect: () => onStatus("hidden"),
          },
        ]
      : []),
    ...(category.status === "hidden"
      ? [
          {
            key: "show",
            label: "Показать…",
            icon: "eye" as const,
            disabled: !online,
            onSelect: () => onStatus("active"),
          },
        ]
      : []),
    category.status !== "archived"
      ? {
          key: "archive",
          label: "В архив…",
          icon: "archive" as const,
          destructive: true,
          disabled: !online,
          onSelect: () => onStatus("archived"),
        }
      : {
          key: "restore",
          label: "Восстановить…",
          icon: "circleCheck" as const,
          disabled: !online,
          onSelect: () => onStatus("active"),
        },
  ];
  return (
    <div className="detail-stack cat-detail">
      <div className="card cat-detail__head">
        <div className="cat-detail__title-row">
          <span className="cat-detail__glyph" aria-hidden="true">
            {category.icon ? (
              <CategoryGlyph icon={category.icon} size={28} />
            ) : (
              <Icon name="category" size={24} />
            )}
          </span>
          <div className="cat-detail__title">
            <h2 className="cat-detail__name">{name}</h2>
            <NamesLine texts={category.names} />
          </div>
          <div className="cat-detail__actions">
            <Button variant="secondary" size="s" disabled={!online} onClick={onEdit}>
              Изменить
            </Button>
            {isNode && (
              <Button
                variant="secondary"
                size="s"
                icon="plus"
                disabled={!online}
                onClick={onAddChild}
              >
                Подкатегория
              </Button>
            )}
            <MenuButton size="s" label={`Статус: ${name}`} actions={statusActions} />
          </div>
        </div>
        <div className="badges cat-detail__marks">
          <StatusBadge kind="category" status={category.status}>
            {CATEGORY_STATUS_TEXT[category.status]}
          </StatusBadge>
          {!category.visibleToClients && (
            <Badge tone="warning" icon="lock">
              Клиенты не видят
            </Badge>
          )}
          <TypeMark icon="category">
            {isNode ? "Узел" : `Подкатегория узла «${ruText(node.names)}»`}
          </TypeMark>
          {!isNode && category.kind === "goods" && category.compatibilityRequired && (
            <TypeMark icon="car">Совместимость обязательна</TypeMark>
          )}
          <span className="code-text" title="Код категории">
            {category.code}
          </span>
        </div>
        {!isNode && (
          <AppLink href={itemsLink({ categoryId: category.id })} className="cat-detail__items">
            Позиции подкатегории →
          </AppLink>
        )}
      </div>
      <section className="card cat-block">
        <div className="section__head">
          <h3 className="section__title">Синонимы для поиска</h3>
        </div>
        <SearchSynonyms
          key={category.id}
          owner={{ kind: "category", id: category.id }}
          intro={
            isNode
              ? "По ним в приложении найдутся все позиции подкатегорий этого узла."
              : "По ним в приложении найдутся все позиции этой подкатегории: «колодки», «brake pads», «тежегіш қалыптары»."
          }
        />
      </section>
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
          <legend className="ac-field__label">Значок</legend>
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
          <Select
            label="Узел (перенос)"
            value={parentId ?? ""}
            options={nodesOfKind.map((node) => ({ value: node.id, label: ruText(node.names) }))}
            onChange={setParentId}
            error={fieldError("parentId")}
          />
        )}
        {error && !error.field && (
          <Banner
            tone="warning"
            action={
              error.conflict ? (
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
              ) : undefined
            }
          >
            {error.text}
          </Banner>
        )}
      </div>
    </Dialog>
  );
}
