import type {
  AdminAttribute,
  AdminCatalogItemListEntry,
  AdminCategoryTreeResponse,
  AdminMaintenanceItem,
  AdminMaintenancePlanResponse,
  MaintenanceItemKind,
  MaintenanceTarget,
  ShowcaseAttributeFilter,
} from "@adclub/contracts";
import { Banner, Button, Chip, ChipRow, Dialog, Segments, Select, TextField } from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../../api";
import { useLoad } from "../../use-load";
import { whoChanged } from "../shared";
import { AttributeConditions, usableAttributes } from "./AttributeConditions";
import {
  codesOf,
  currentConditions,
  isMaintenanceConflict,
  maintenanceErrorText,
  numberOf,
} from "./maintenance-words";

type RuleKind = "category" | "items";

interface Draft {
  kind: MaintenanceItemKind;
  ru: string;
  kk: string;
  en: string;
  intervalKm: string;
  intervalMonths: string;
  firstKm: string;
  firstMonths: string;
  codes: string;
  quantity: string;
  note: string;
  rule: RuleKind;
  categoryId: string;
  attributes: ShowcaseAttributeFilter[];
  items: { id: string; label: string }[];
}

const text = (value: number | null) => (value === null ? "" : String(value));

function draftOf(item: AdminMaintenanceItem | null): Draft {
  const target = item?.target ?? null;
  return {
    kind: item?.kind ?? "part",
    ru: item?.title.ru?.text ?? "",
    kk: item?.title.kk?.origin === "manual" ? item.title.kk.text : "",
    en: item?.title.en?.origin === "manual" ? item.title.en.text : "",
    intervalKm: text(item?.intervalKm ?? null),
    intervalMonths: text(item?.intervalMonths ?? null),
    firstKm: text(item?.firstKm ?? null),
    firstMonths: text(item?.firstMonths ?? null),
    codes: item?.serviceCodes.join(", ") ?? "",
    quantity: text(item?.quantity ?? null),
    note: item?.note ?? "",
    rule: target?.kind ?? "category",
    categoryId: target?.kind === "category" ? target.categoryId : "",
    attributes: target?.kind === "category" ? [...target.attributes] : [],
    items:
      target?.kind === "items"
        ? target.itemIds.map((id) => ({ id, label: item?.targetLabel ?? id }))
        : [],
  };
}

function itemLabel(item: AdminCatalogItemListEntry): string {
  return [item.brand?.name, item.article, item.names.ru?.text].filter(Boolean).join(" · ");
}

/**
 * Adding and changing an element (TASK-061): the kind, the Russian title
 * (Kazakh and English are translated automatically, «Исправить» writes them
 * by hand), the intervals, the service codes, and the rule — a subcategory
 * of the kind with conditions by its filters, or particular items found by
 * article or name. The server checks the rule against the catalog.
 */
export function ItemDialog({
  planId,
  editing,
  onCancel,
  onDone,
}: {
  planId: string;
  editing: AdminMaintenanceItem | "new" | null;
  onCancel: () => void;
  onDone: (answer: AdminMaintenancePlanResponse, text: string) => void;
}) {
  const [shown, setShown] = useState<typeof editing>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [fixTranslation, setFixTranslation] = useState(false);
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // The conditions dropped on opening because the catalog no longer has them (TASK-061.A).
  const [cleaned, setCleaned] = useState<{ itemId: string | null; removed: string[] }>({
    itemId: null,
    removed: [],
  });
  if (editing !== shown) {
    setShown(editing);
    setCleaned({ itemId: null, removed: [] });
    setDraft(draftOf(editing === "new" ? null : editing));
    setFixTranslation(false);
    setError(null);
  }
  const item = editing === "new" ? null : editing;
  const set = (patch: Partial<Draft>) => setDraft((now) => ({ ...now, ...patch }));

  const tree = useLoad<AdminCategoryTreeResponse>(
    () => apiClient.listAdminCategories(),
    "maintenance-tree",
  );
  const kindOf = draft.kind === "part" ? "goods" : "services";
  const subcategories = (tree.data?.categories ?? [])
    .filter((node) => node.kind === kindOf && node.status === "active")
    .flatMap((node) =>
      node.children
        .filter((child) => child.status === "active" || child.id === draft.categoryId)
        .map((child) => ({
          value: child.id,
          label: `${node.names.ru?.text ?? node.code} · ${child.names.ru?.text ?? child.code}${child.status === "active" ? "" : " (скрыта)"}`,
        })),
    );
  const [attributes, setAttributes] = useState<{
    categoryId: string;
    list: AdminAttribute[];
    failed?: boolean;
  }>({
    categoryId: "",
    list: [],
  });
  useEffect(() => {
    if (!draft.categoryId || draft.categoryId === attributes.categoryId) return;
    let cancelled = false;
    apiClient.listAdminAttributes({ categoryId: draft.categoryId }).then(
      (answer) =>
        !cancelled && setAttributes({ categoryId: draft.categoryId, list: answer.attributes }),
      () => !cancelled && setAttributes({ categoryId: draft.categoryId, list: [], failed: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [draft.categoryId, attributes.categoryId]);

  if (
    item?.target?.kind === "category" &&
    cleaned.itemId !== item.id &&
    draft.categoryId === item.target.categoryId &&
    attributes.categoryId === draft.categoryId &&
    !attributes.failed
  ) {
    const usable = new Set(usableAttributes(attributes.list).map((entry) => entry.id));
    const result = currentConditions(
      draft.attributes,
      attributes.list.map((entry) => ({
        id: entry.id,
        name: entry.names.ru?.text ?? entry.code,
        usable: usable.has(entry.id),
        activeOptionIds: entry.options
          .filter((option) => option.status === "active")
          .map((option) => option.id),
      })),
    );
    setCleaned({ itemId: item.id, removed: result.removed });
    if (result.removed.length > 0) set({ attributes: result.kept });
  }

  const [query, setQuery] = useState("");
  const [found, setFound] = useState<AdminCatalogItemListEntry[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiClient
        .listAdminCatalogItems({
          query: {
            q,
            status: "active",
            ...(draft.kind === "service" ? { type: "service" } : {}),
            limit: 10,
          },
        })
        .then(
          (page) =>
            !cancelled &&
            setFound(
              page.items.filter(
                (entry) => (draft.kind === "service") === (entry.type === "service"),
              ),
            ),
          () => !cancelled && setFound([]),
        );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, draft.kind]);

  const numbers = {
    intervalKm: numberOf(draft.intervalKm),
    intervalMonths: numberOf(draft.intervalMonths),
    firstKm: numberOf(draft.firstKm),
    firstMonths: numberOf(draft.firstMonths),
    quantity: numberOf(draft.quantity),
  };
  const badNumber = Object.values(numbers).some((value) => value === undefined);
  const target: MaintenanceTarget | null =
    draft.rule === "category"
      ? draft.categoryId
        ? { kind: "category", categoryId: draft.categoryId, attributes: draft.attributes }
        : null
      : draft.items.length > 0
        ? { kind: "items", itemIds: draft.items.map((entry) => entry.id) }
        : null;
  const missing = !draft.ru.trim()
    ? "Укажите название работы"
    : numbers.intervalKm === null && numbers.intervalMonths === null
      ? "Укажите интервал в километрах или в месяцах"
      : target === null
        ? draft.rule === "category"
          ? "Выберите подкатегорию"
          : "Добавьте хотя бы одну позицию"
        : null;

  const submit = async () => {
    if (missing || badNumber || target === null) return;
    setBusy(true);
    setError(null);
    const fields = {
      intervalKm: numbers.intervalKm ?? null,
      intervalMonths: numbers.intervalMonths ?? null,
      firstKm: numbers.firstKm ?? null,
      firstMonths: numbers.firstMonths ?? null,
      serviceCodes: codesOf(draft.codes),
      quantity: numbers.quantity ?? null,
      note: draft.note.trim() || null,
      target,
    };
    const title = {
      ru: draft.ru.trim(),
      ...(fixTranslation || !item
        ? { kk: draft.kk.trim() || null, en: draft.en.trim() || null }
        : {}),
    };
    try {
      if (item) {
        const answer = await apiClient.updateMaintenanceItem(
          { itemId: item.id },
          { expectedVersion: item.version, title, ...fields },
        );
        onDone(answer, "Элемент изменён");
      } else {
        const answer = await apiClient.createMaintenanceItem(
          { planId },
          { kind: draft.kind, title, ...fields },
        );
        onDone(answer, "Элемент добавлен");
      }
    } catch (thrown) {
      if (isMaintenanceConflict(thrown) && item) {
        setError({
          text: `Эти данные только что изменил ${(await whoChanged("maintenance_plan_item", item.id)) ?? "другой администратор"}. Обновите страницу`,
          conflict: true,
        });
      } else {
        setError({ text: maintenanceErrorText(thrown), conflict: false });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={editing !== null}
      onClose={onCancel}
      title={item ? "Изменить элемент" : "Новый элемент"}
      actions={
        <>
          <Button
            loading={busy}
            disabled={missing !== null || badNumber}
            onClick={() => void submit()}
          >
            Сохранить
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        {item ? (
          <p className="ac-text-body-s ac-muted">
            {draft.kind === "part" ? "Запчасть или жидкость" : "Услуга"} — вид не меняется
          </p>
        ) : (
          <Segments<MaintenanceItemKind>
            label="Вид"
            value={draft.kind}
            options={[
              { value: "part", label: "Запчасть" },
              { value: "service", label: "Услуга" },
            ]}
            onChange={(kind) => set({ kind, categoryId: "", attributes: [], items: [] })}
          />
        )}
        <TextField
          label="Название работы"
          value={draft.ru}
          onChange={(ru) => set({ ru })}
          hint="По-русски; казахский и английский переведутся автоматически"
        />
        {item && !fixTranslation ? (
          <div className="row-actions">
            <span className="ac-text-caption ac-muted">
              kk: {item.title.kk?.text ?? "перевод в пути"} · en:{" "}
              {item.title.en?.text ?? "перевод в пути"}
            </span>
            <Button variant="text" size="s" onClick={() => setFixTranslation(true)}>
              Исправить
            </Button>
          </div>
        ) : (
          <div className="row-actions">
            <TextField
              label="Казахский"
              value={draft.kk}
              onChange={(kk) => set({ kk })}
              hint="Пусто — переведёт ИИ"
            />
            <TextField
              label="Английский"
              value={draft.en}
              onChange={(en) => set({ en })}
              hint="Пусто — переведёт ИИ"
            />
          </div>
        )}
        <div className="row-actions">
          <TextField
            label="Каждые, км"
            value={draft.intervalKm}
            onChange={(intervalKm) => set({ intervalKm })}
            inputMode="numeric"
            hint="1 000…120 000"
            error={numbers.intervalKm === undefined ? "Только цифры" : undefined}
          />
          <TextField
            label="Каждые, мес"
            value={draft.intervalMonths}
            onChange={(intervalMonths) => set({ intervalMonths })}
            inputMode="numeric"
            hint="1…120"
            error={numbers.intervalMonths === undefined ? "Только цифры" : undefined}
          />
        </div>
        <div className="row-actions">
          <TextField
            label="Первый раз, км"
            value={draft.firstKm}
            onChange={(firstKm) => set({ firstKm })}
            inputMode="numeric"
            hint="Если раньше обычного"
            error={numbers.firstKm === undefined ? "Только цифры" : undefined}
          />
          <TextField
            label="Первый раз, мес"
            value={draft.firstMonths}
            onChange={(firstMonths) => set({ firstMonths })}
            inputMode="numeric"
            error={numbers.firstMonths === undefined ? "Только цифры" : undefined}
          />
        </div>
        <TextField
          label="Коды ТО"
          value={draft.codes}
          onChange={(codes) => set({ codes })}
          hint="Через запятую: ТО-1, ТО-2"
        />
        {codesOf(draft.codes).length > 0 && (
          <ChipRow label="Коды ТО">
            {codesOf(draft.codes).map((code) => (
              <Chip
                key={code}
                selected
                onClick={() =>
                  set({
                    codes: codesOf(draft.codes)
                      .filter((entry) => entry !== code)
                      .join(", "),
                  })
                }
              >
                {code}
              </Chip>
            ))}
          </ChipRow>
        )}
        <Segments<RuleKind>
          label="Правило подбора"
          value={draft.rule}
          options={[
            { value: "category", label: "Подкатегория и условия" },
            { value: "items", label: "Конкретные позиции" },
          ]}
          onChange={(rule) => set({ rule })}
        />
        {draft.rule === "category" ? (
          <>
            <Select<string>
              label="Подкатегория"
              value={draft.categoryId || null}
              placeholder={draft.kind === "part" ? "Подкатегория товаров" : "Подкатегория услуг"}
              options={subcategories}
              onChange={(categoryId) => set({ categoryId, attributes: [] })}
            />
            {cleaned.removed.length > 0 && (
              <Banner tone="warning">
                <div className="cell-stack">
                  {cleaned.removed.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                  <span className="ac-text-caption">
                    Сохраните элемент, чтобы правило стало таким
                  </span>
                </div>
              </Banner>
            )}
            {draft.categoryId && attributes.categoryId === draft.categoryId && (
              <AttributeConditions
                attributes={attributes.list}
                value={draft.attributes}
                onChange={(next) => set({ attributes: next })}
              />
            )}
          </>
        ) : (
          <>
            {draft.items.length > 0 && (
              <ChipRow label="Позиции правила">
                {draft.items.map((entry) => (
                  <Chip
                    key={entry.id}
                    selected
                    onClick={() =>
                      set({ items: draft.items.filter((other) => other.id !== entry.id) })
                    }
                  >
                    {entry.label} ✕
                  </Chip>
                ))}
              </ChipRow>
            )}
            <TextField
              label="Найти позицию"
              value={query}
              onChange={setQuery}
              placeholder="Артикул в любом написании или название"
            />
            {query.trim().length >= 2 && found.length > 0 && (
              <ChipRow label="Найдено">
                {found
                  .filter((entry) => !draft.items.some((chosen) => chosen.id === entry.id))
                  .map((entry) => (
                    <Chip
                      key={entry.id}
                      selected={false}
                      onClick={() =>
                        set({ items: [...draft.items, { id: entry.id, label: itemLabel(entry) }] })
                      }
                    >
                      + {itemLabel(entry)}
                    </Chip>
                  ))}
              </ChipRow>
            )}
          </>
        )}
        <div className="row-actions">
          <TextField
            label="Количество"
            value={draft.quantity}
            onChange={(quantity) => set({ quantity })}
            inputMode="numeric"
            hint="Если больше одной штуки"
            error={numbers.quantity === undefined ? "Только цифры" : undefined}
          />
          <TextField
            label="Заметка"
            value={draft.note}
            onChange={(note) => set({ note })}
            hint="Для администратора, до 200 знаков"
          />
        </div>
        {missing && <span className="ac-text-caption ac-muted">{missing}</span>}
        {error && <Banner tone="warning">{error.text}</Banner>}
      </div>
    </Dialog>
  );
}
