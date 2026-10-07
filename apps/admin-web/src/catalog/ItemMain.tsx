import { isApiError } from "@adclub/api-client";
import {
  catalogItemDuplicateDetailsSchema,
  type AdminBrand,
  type AdminCatalogItemCard,
  type AdminCategoryTreeResponse,
  type AdminItemOffersResponse,
  type CatalogItemBrand,
  type CatalogItemStatus,
  type CatalogItemType,
} from "@adclub/contracts";
import { normalizeArticle } from "@adclub/domain";
import {
  Banner,
  Button,
  Dialog,
  LoadingContent,
  SearchField,
  Segments,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { catalogItemPath, navigateTo, routePaths, useLocation } from "../router";
import { useLoad } from "../use-load";
import {
  ITEM_STATUS_TEXT,
  ITEM_TYPE_TEXT,
  catalogErrorText,
  conflictText,
  errorField,
  isConflict,
} from "./catalog-words";
import { subcategoryNames } from "./Items";
import { AppLink, CatalogTabs, whoChanged } from "./shared";
import { ruText } from "./values";

interface Form {
  type: CatalogItemType;
  categoryId: string;
  brand: CatalogItemBrand | null;
  article: string;
  ru: string;
  kk: string;
  en: string;
}

interface FormError {
  text: string;
  field: string | null;
  conflict?: boolean;
  existingItemId?: string;
}

function formOf(card: AdminCatalogItemCard): Form {
  return {
    type: card.item.type,
    categoryId: card.item.categoryId,
    brand: card.item.brand,
    article: card.item.article ?? "",
    ru: card.item.names.ru?.text ?? "",
    kk: card.item.names.kk?.text ?? "",
    en: card.item.names.en?.text ?? "",
  };
}

function sameForm(a: Form, b: Form): boolean {
  return (
    a.type === b.type &&
    a.categoryId === b.categoryId &&
    (a.brand?.id ?? null) === (b.brand?.id ?? null) &&
    a.article === b.article &&
    a.ru === b.ru &&
    a.kk === b.kk &&
    a.en === b.en
  );
}

function duplicateOf(thrown: unknown): string | undefined {
  if (!isApiError(thrown) || thrown.code !== "CATALOG_ITEM_DUPLICATE") return undefined;
  const details = catalogItemDuplicateDetailsSchema.safeParse(thrown.details);
  return details.success ? details.data.existingItemId : undefined;
}

/** «Основное» of the card (A-CAT-05): the same form edits an item and creates one. */
export function ItemMain({
  card,
  onChanged,
  onReload,
}: {
  card: AdminCatalogItemCard;
  onChanged: (card: AdminCatalogItemCard) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  // `base` — the item as the form was filled from: only what the
  // administrator changed against it is sent, so a colleague's change of
  // another field, read after «Обновить», is never sent back over.
  const [base, setBase] = useState<Form>(() => formOf(card));
  const [form, setForm] = useState<Form>(base);
  const [error, setError] = useState<FormError | null>(null);
  const [statusTo, setStatusTo] = useState<CatalogItemStatus | null>(null);
  const item = card.item;
  const fresh = formOf(card);
  if (!sameForm(fresh, base) && sameForm(form, base)) {
    // Nothing typed: show the item as it is now.
    setBase(fresh);
    setForm(fresh);
  }

  const save = async () => {
    setError(null);
    const changes: Parameters<typeof apiClient.updateCatalogItem>[1] = {
      expectedVersion: item.version,
    };
    if (form.categoryId !== base.categoryId) changes.categoryId = form.categoryId;
    if ((form.brand?.id ?? null) !== (base.brand?.id ?? null))
      changes.brandId = form.brand?.id ?? null;
    if (form.article.trim() !== base.article.trim()) changes.article = form.article.trim() || null;
    if (form.ru.trim() !== base.ru.trim()) changes.names = { ru: form.ru.trim() };
    if (Object.keys(changes).length === 1) {
      toast.show("Изменений нет");
      return;
    }
    try {
      const saved = await apiClient.updateCatalogItem({ itemId: item.id }, changes);
      setBase(formOf(saved));
      setForm(formOf(saved));
      onChanged(saved);
      toast.show("Сохранено");
    } catch (thrown) {
      if (isConflict(thrown)) {
        setError({
          text: conflictText(await whoChanged("catalog_item", item.id)),
          field: null,
          conflict: true,
        });
      } else {
        setError({
          text: catalogErrorText(thrown),
          field: errorField(thrown),
          existingItemId: duplicateOf(thrown),
        });
      }
    }
  };

  const setStatus = async (status: CatalogItemStatus) => {
    setError(null);
    try {
      onChanged(
        await apiClient.setCatalogItemStatus(
          { itemId: item.id },
          { status, expectedVersion: item.version },
        ),
      );
      toast.show(`Статус: ${ITEM_STATUS_TEXT[status].toLowerCase()}`);
    } catch (thrown) {
      if (isConflict(thrown)) {
        setError({
          text: conflictText(await whoChanged("catalog_item", item.id)),
          field: null,
          conflict: true,
        });
      } else {
        setError({
          text: catalogErrorText(thrown),
          field: null,
          existingItemId: duplicateOf(thrown),
        });
      }
    } finally {
      setStatusTo(null);
    }
  };

  return (
    <div className="detail-stack">
      <ItemFields form={form} onChange={setForm} creating={false} error={error} online={online} />
      <p className="ac-text-caption ac-muted">
        Казахское и английское названия правятся во вкладке «Переводы».
      </p>
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
                Обновить
              </Button>
            ) : undefined
          }
        >
          {error.text}
          {error.existingItemId && (
            <>
              {" "}
              <AppLink href={catalogItemPath(error.existingItemId)}>Открыть её</AppLink>
            </>
          )}
        </Banner>
      )}
      <div className="button-row">
        <Button disabled={!online} onClick={save}>
          Сохранить
        </Button>
        {item.status !== "active" && (
          <Button variant="secondary" disabled={!online} onClick={() => setStatus("active")}>
            {item.status === "archived" ? "Восстановить" : "Сделать активной"}
          </Button>
        )}
        {item.status === "active" && (
          <Button variant="secondary" disabled={!online} onClick={() => setStatus("draft")}>
            В черновик
          </Button>
        )}
        {item.status !== "archived" && (
          <Button variant="text" disabled={!online} onClick={() => setStatusTo("archived")}>
            В архив
          </Button>
        )}
      </div>
      <ArchiveDialog
        itemId={statusTo === "archived" ? item.id : null}
        name={ruText(item.names)}
        status={item.status}
        onConfirm={() => setStatus("archived")}
        onCancel={() => setStatusTo(null)}
      />
    </div>
  );
}

/**
 * Archiving with offers (SCREENS A-CAT-05): «У позиции N предложений и M
 * активных заявок…» — both numbers are the server's, read when the dialog opens.
 */
function ArchiveDialog({
  itemId,
  name,
  status,
  onConfirm,
  onCancel,
}: {
  itemId: string | null;
  name: string;
  status: CatalogItemStatus;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [answer, setAnswer] = useState<{
    itemId: string;
    offers: AdminItemOffersResponse | "failed";
  } | null>(null);
  // Read anew on every opening: the numbers are the server's now.
  const offers = answer && answer.itemId === itemId ? answer.offers : null;
  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    apiClient.listAdminItemOffers({ itemId }).then(
      (found) => !cancelled && setAnswer({ itemId, offers: found }),
      () => !cancelled && setAnswer({ itemId, offers: "failed" }),
    );
    return () => {
      cancelled = true;
    };
  }, [itemId]);
  return (
    <Dialog
      open={itemId !== null}
      onClose={onCancel}
      title="Убрать позицию в архив?"
      actions={
        <>
          <Button onClick={onConfirm} disabled={offers === null}>
            В архив
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        <div className="was-now">
          <span className="was-now__line">
            <span className="ac-muted">«{name}»:</span>
            <span className="was-now__value">{ITEM_STATUS_TEXT[status]}</span>→
            <span className="was-now__value was-now__value--new">В архиве</span>
          </span>
        </div>
        {offers === null ? (
          <SkeletonList rows={1} label="Считаем предложения" />
        ) : offers === "failed" ? (
          <p className="ac-text-body-s warning-text">
            Не удалось узнать, сколько у позиции предложений и заявок. Предложения на ней будут
            сняты с витрины, активные заявки нужно будет выполнить.
          </p>
        ) : offers.onSale > 0 || offers.activeOrders > 0 ? (
          <p className="ac-text-body-s">
            У позиции {offers.onSale}{" "}
            {plural(offers.onSale, "предложение", "предложения", "предложений")} и{" "}
            {offers.activeOrders}{" "}
            {plural(offers.activeOrders, "активная заявка", "активные заявки", "активных заявок")}.
            Предложения будут сняты с витрины, заявки нужно выполнить.
          </p>
        ) : (
          <p className="ac-text-body-s">
            Предложений и активных заявок нет. Позиция уйдёт из каталога и из выбора для новых
            предложений; вернуть можно кнопкой «Восстановить».
          </p>
        )}
      </div>
    </Dialog>
  );
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** The fields of an item, shared by the card and the creation (A-CAT-05 «Основное»). */
function ItemFields({
  form,
  onChange,
  creating,
  error,
  online,
}: {
  form: Form;
  onChange: (form: Form) => void;
  creating: boolean;
  error: FormError | null;
  online: boolean;
}) {
  const tree = useLoad<AdminCategoryTreeResponse>(() => apiClient.listAdminCategories(), "tree");
  const kind = form.type === "service" ? "services" : "goods";
  const subcategories = [...subcategoryNames(tree.data)].filter(([id]) =>
    tree.data?.categories.some(
      (node) => node.kind === kind && node.children.some((child) => child.id === id),
    ),
  );
  const fieldError = (field: string) => (error?.field === field ? error.text : undefined);
  const set = (patch: Partial<Form>) => onChange({ ...form, ...patch });

  return (
    <div className="form-grid">
      {creating ? (
        <Segments<CatalogItemType>
          label="Тип"
          options={(Object.keys(ITEM_TYPE_TEXT) as CatalogItemType[]).map((type) => ({
            value: type,
            label: ITEM_TYPE_TEXT[type],
          }))}
          value={form.type}
          onChange={(type) =>
            set({
              type,
              categoryId: "",
              ...(type === "service" ? { brand: null, article: "" } : {}),
            })
          }
        />
      ) : (
        <p className="ac-text-body-s">
          <span className="ac-muted">Тип:</span> {ITEM_TYPE_TEXT[form.type]} (не меняется)
        </p>
      )}
      <label className="select">
        <span className="ac-text-caption ac-muted">Подкатегория</span>
        <select
          value={form.categoryId}
          disabled={!online}
          aria-invalid={error?.field === "categoryId" || undefined}
          onChange={(event) => set({ categoryId: event.target.value })}
        >
          <option value="">Выберите</option>
          {subcategories.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        {fieldError("categoryId") && (
          <span className="dialog-error">{fieldError("categoryId")}</span>
        )}
      </label>
      {form.type !== "service" && (
        <>
          <BrandPicker
            brand={form.brand}
            onChange={(brand) => set({ brand })}
            error={fieldError("brandId")}
          />
          <TextField
            label={form.type === "part" ? "Артикул" : "Артикул (если есть)"}
            value={form.article}
            onChange={(article) => set({ article })}
            error={fieldError("article")}
            hint={
              form.article.trim()
                ? `Нормализованный вид: ${normalizeArticle(form.article) || "—"} — по нему ищется и проверяется дубль`
                : "Любое написание: пробелы, дефисы и регистр не важны"
            }
            autoComplete="off"
          />
        </>
      )}
      <TextField
        label="Название (рус.)"
        value={form.ru}
        onChange={(ru) => set({ ru })}
        error={fieldError("names.ru")}
      />
      {creating && (
        <>
          <TextField
            label="Название (каз.)"
            value={form.kk}
            onChange={(kk) => set({ kk })}
            error={fieldError("names.kk")}
            hint="Пусто — переведёт ИИ"
          />
          <TextField
            label="Название (англ.)"
            value={form.en}
            onChange={(en) => set({ en })}
            error={fieldError("names.en")}
            hint="Пусто — переведёт ИИ"
          />
        </>
      )}
    </div>
  );
}

/** A brand chosen by any of its spellings (`q` of the brands list), or a new one. */
function BrandPicker({
  brand,
  onChange,
  error,
}: {
  brand: CatalogItemBrand | null;
  onChange: (brand: CatalogItemBrand | null) => void;
  error?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ q: string; brands: AdminBrand[] }>({
    q: "",
    brands: [],
  });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAliases, setNewAliases] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // Only the answer to what is typed now is shown.
  const found = results.q && results.q === query.trim() ? results.brands : [];

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiClient.listAdminBrands({ query: { q, limit: 10, status: "active" } }).then(
        (page) => !cancelled && setResults({ q, brands: page.brands }),
        () => !cancelled && setResults({ q, brands: [] }),
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const create = async () => {
    setCreateError(null);
    try {
      const created = await apiClient.createBrand({
        name: newName.trim(),
        aliases: newAliases
          .split(",")
          .map((alias) => alias.trim())
          .filter(Boolean),
      });
      onChange({
        id: created.brand.id,
        name: created.brand.name,
        isOem: created.brand.isOem,
        status: created.brand.status,
      });
      setCreating(false);
      setNewName("");
      setNewAliases("");
    } catch (thrown) {
      setCreateError(catalogErrorText(thrown));
    }
  };

  return (
    <div className="brand-picker">
      <span className="ac-text-caption ac-muted">Бренд</span>
      {brand ? (
        <div className="button-row">
          <span className="ac-text-body-strong">{brand.name}</span>
          {brand.status === "archived" && <span className="warning-text">в архиве</span>}
          <Button variant="text" size="s" onClick={() => onChange(null)}>
            Сменить
          </Button>
        </div>
      ) : (
        <>
          <SearchField
            label="Найти бренд по любому написанию"
            value={query}
            onChange={setQuery}
            clearLabel="Очистить"
          />
          {found.length > 0 && (
            <ul className="pick-list">
              {found.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="pick-list__item"
                    onClick={() => {
                      onChange({
                        id: entry.id,
                        name: entry.name,
                        isOem: entry.isOem,
                        status: entry.status,
                      });
                      setQuery("");
                    }}
                  >
                    <span className="ac-text-body-strong">{entry.name}</span>
                    {entry.aliases.length > 0 && (
                      <span className="ac-text-caption ac-muted">
                        {" "}
                        · {entry.aliases.join(", ")}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && found.length === 0 && (
            <span className="ac-text-caption ac-muted">Не нашлось — можно создать новый бренд</span>
          )}
          {creating ? (
            <div className="localized-fields">
              <TextField label="Название бренда" value={newName} onChange={setNewName} />
              <TextField
                label="Другие написания через запятую"
                value={newAliases}
                onChange={setNewAliases}
                hint="GEELY Auto, Джили"
              />
              {createError && <p className="dialog-error">{createError}</p>}
              <div className="button-row">
                <Button size="s" onClick={create} disabled={!newName.trim()}>
                  Создать бренд
                </Button>
                <Button variant="text" size="s" onClick={() => setCreating(false)}>
                  Отмена
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="text"
              size="s"
              icon="plus"
              onClick={() => {
                setCreating(true);
                setNewName(query.trim());
              }}
            >
              Новый бренд
            </Button>
          )}
        </>
      )}
      {error && <span className="dialog-error">{error}</span>}
    </div>
  );
}

/** «Новая позиция» — the form of «Основное» for an item that doesn't exist yet. */
export function ItemCreate() {
  const toast = useToast();
  const online = useOnline();
  const { query } = useLocation();
  const [form, setForm] = useState<Form>({
    type: "part",
    categoryId: query.get("categoryId") ?? "",
    brand: null,
    article: "",
    ru: "",
    kk: "",
    en: "",
  });
  const [error, setError] = useState<FormError | null>(null);
  const [saving, setSaving] = useState(false);
  const tree = useLoad<AdminCategoryTreeResponse>(() => apiClient.listAdminCategories(), "tree");

  const create = async (status: "draft" | "active") => {
    setError(null);
    if (!form.categoryId) {
      setError({ text: "Выберите подкатегорию", field: "categoryId" });
      return;
    }
    if (!form.ru.trim()) {
      setError({ text: "Название обязательно", field: "names.ru" });
      return;
    }
    const optional = (value: string) => (value.trim() ? value.trim() : null);
    setSaving(true);
    try {
      const created = await apiClient.createCatalogItem({
        type: form.type,
        categoryId: form.categoryId,
        ...(form.type !== "service"
          ? { brandId: form.brand?.id ?? null, article: optional(form.article) }
          : {}),
        names: { ru: form.ru.trim(), kk: optional(form.kk), en: optional(form.en) },
        status,
      });
      toast.show("Позиция создана");
      navigateTo(catalogItemPath(created.item.id, "values"), { replace: true });
    } catch (thrown) {
      setError({
        text: catalogErrorText(thrown),
        field: errorField(thrown),
        existingItemId: duplicateOf(thrown),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Новая позиция</h1>
      </div>
      <CatalogTabs active={null} />
      <LoadingContent
        ready={tree.data !== undefined}
        indicator={tree.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <div className="detail-stack">
          <ItemFields form={form} onChange={setForm} creating error={error} online={online} />
          {error && (!error.field || error.existingItemId) && (
            <Banner tone="warning">
              {error.text}
              {error.existingItemId && (
                <>
                  {" "}
                  <AppLink href={catalogItemPath(error.existingItemId)}>Открыть её</AppLink>
                </>
              )}
            </Banner>
          )}
          <p className="ac-text-caption ac-muted">
            После создания откроются характеристики позиции. Фото, переводы и совместимость — в
            соседних вкладках.
          </p>
          <div className="button-row">
            <Button disabled={!online} loading={saving} onClick={() => create("active")}>
              Создать
            </Button>
            <Button
              variant="secondary"
              disabled={!online || saving}
              onClick={() => create("draft")}
            >
              Сохранить черновиком
            </Button>
            <AppLink href={routePaths.catalogItems}>Отмена</AppLink>
          </div>
        </div>
      </LoadingContent>
    </>
  );
}
