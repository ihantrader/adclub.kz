import type {
  AdminAttribute,
  AdminAttributeListResponse,
  AdminAttributeOption,
  AdminAttributeResponse,
  AdminCategory,
  AttributeValueType,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  IconButton,
  LoadingContent,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { catalogFillPath, navigateTo, withQuery } from "../router";
import { useLoad } from "../use-load";
import {
  VALUE_TYPE_TEXT,
  catalogErrorText,
  conflictText,
  errorField,
  isConflict,
} from "./catalog-words";
import { suggestCode } from "./codes";
import { itemsLink } from "./item-filters";
import { attributeOrderBody, optionOrderBody } from "./order";
import { AppLink, TextsLine, whoChanged } from "./shared";
import { numberHint, numberText, ruText } from "./values";

type Names = { ru: string; kk: string; en: string };

/** What the last answer about an attribute said (SCREENS A-CAT-02). */
interface Notice {
  attribute: AdminAttribute;
  created: boolean;
  itemsWithoutValue: number;
  sameProductItems: number;
}

/**
 * A-CAT-02 «Характеристики» of one subcategory (TASK-035): type, unit,
 * «Использовать в фильтрах», «Участвует в полноте», the order (with the
 * order it was made from, I151), archiving that keeps the values, the
 * options of a list with their order and archive. A new attribute says how
 * many items are left without its value and leads to the fill; a change
 * that made products the same shows a clear warning with a link to them.
 */
export function AttributesPanel({
  category,
  highlightAttributeId,
  highlightOptionId,
}: {
  category: AdminCategory;
  highlightAttributeId: string | null;
  highlightOptionId: string | null;
}) {
  const toast = useToast();
  const online = useOnline();
  const list = useLoad<AdminAttributeListResponse>(
    () => apiClient.listAdminAttributes({ categoryId: category.id }),
    `attributes:${category.id}`,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<{ attributeId: string | null } | null>(null);
  const [optionsOf, setOptionsOf] = useState<string | null>(
    highlightOptionId ? highlightAttributeId : null,
  );
  const [archiving, setArchiving] = useState<AdminAttribute | null>(null);
  const attributes = list.data?.attributes ?? [];
  const byId = (id: string | null) => attributes.find((entry) => entry.id === id) ?? null;

  const fail = async (thrown: unknown, entityType: string, entityId: string) => {
    if (isConflict(thrown)) {
      setError(conflictText(await whoChanged(entityType, entityId)));
      list.reload();
    } else {
      setError(catalogErrorText(thrown));
    }
  };

  const answered = (response: AdminAttributeResponse, created: boolean) => {
    setNotice({
      attribute: response.attribute,
      created,
      itemsWithoutValue: response.itemsWithoutValue,
      sameProductItems: response.sameProductItems,
    });
    list.reload();
  };

  const move = async (index: number, by: -1 | 1) => {
    const body = attributeOrderBody(attributes, index, by);
    if (!body) return;
    setError(null);
    try {
      list.replace(await apiClient.reorderAttributes({ categoryId: category.id }, body));
    } catch (thrown) {
      await fail(thrown, "catalog_attribute", category.id);
    }
  };

  const setStatus = async (attribute: AdminAttribute, status: "active" | "archived") => {
    setError(null);
    try {
      const response = await apiClient.setAttributeStatus(
        { attributeId: attribute.id },
        { status, expectedVersion: attribute.version },
      );
      toast.show(
        status === "archived" ? "Характеристика в архиве" : "Характеристика снова активна",
      );
      answered(response, false);
    } catch (thrown) {
      await fail(thrown, "catalog_attribute", attribute.id);
    } finally {
      setArchiving(null);
    }
  };

  return (
    <div className="card-section">
      <div className="page__head">
        <h3 className="ac-text-heading">Характеристики</h3>
        <div className="button-row">
          <AppLink href={catalogFillPath(category.id)}>Дозаполнение</AppLink>
          <Button
            size="s"
            icon="plus"
            disabled={!online}
            onClick={() => setEditing({ attributeId: null })}
          >
            Добавить характеристику
          </Button>
        </div>
      </div>
      {notice && notice.created && (
        <Banner
          tone="neutral"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() =>
                navigateTo(
                  withQuery(catalogFillPath(category.id), {
                    attribute: notice.attribute.id,
                    empty: "1",
                  }),
                )
              }
            >
              Дозаполнить
            </Button>
          }
        >
          «{ruText(notice.attribute.names)}» добавлена. У {notice.itemsWithoutValue}{" "}
          {notice.itemsWithoutValue === 1 ? "позиции" : "позиций"} значение будет пустым.
        </Banner>
      )}
      {notice && notice.sameProductItems > 0 && (
        <Banner
          tone="warning"
          action={
            <AppLink href={itemsLink({ categoryId: category.id, sameProduct: "matching" })}>
              Показать позиции
            </AppLink>
          }
        >
          После изменения {notice.sameProductItems}{" "}
          {notice.sameProductItems === 1 ? "товар совпадает" : "товаров совпадают"} с другими по
          всем идентифицирующим характеристикам. Разведите их значениями характеристик или отмените
          изменение.
        </Banner>
      )}
      {error && (
        <Banner
          tone="warning"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() => {
                setError(null);
                list.reload();
              }}
            >
              Обновить
            </Button>
          }
        >
          {error}
        </Banner>
      )}
      {list.error !== undefined && <Banner tone="danger">{loadErrorText(list.error)}</Banner>}
      <LoadingContent
        ready={list.data !== undefined}
        indicator={list.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {attributes.length === 0 ? (
          <p className="ac-text-body-s ac-muted">
            У подкатегории пока нет характеристик. Позиции в ней описываются названием, брендом и
            артикулом; добавьте характеристику, чтобы появились формы и фильтры.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="admin-table attributes-table">
              <thead>
                <tr>
                  <th scope="col">Порядок</th>
                  <th scope="col">Характеристика</th>
                  <th scope="col">Тип</th>
                  <th scope="col">Фильтр · полнота</th>
                  <th scope="col">Состояние</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
                {attributes.map((attribute, index) => (
                  <tr
                    key={attribute.id}
                    className={[
                      attribute.status === "archived" ? "row--muted" : "",
                      attribute.id === highlightAttributeId ? "row--highlight" : "",
                    ].join(" ")}
                  >
                    <td>
                      <div className="button-row">
                        <IconButton
                          icon="arrowLeft"
                          className="arrow-up"
                          label={`Выше: ${ruText(attribute.names)}`}
                          disabled={!online || index === 0}
                          onClick={() => move(index, -1)}
                        />
                        <IconButton
                          icon="arrowLeft"
                          className="arrow-down"
                          label={`Ниже: ${ruText(attribute.names)}`}
                          disabled={!online || index === attributes.length - 1}
                          onClick={() => move(index, 1)}
                        />
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack">
                        <span className="ac-text-body-strong">{ruText(attribute.names)}</span>
                        <TextsLine texts={attribute.names} />
                        <span className="ac-text-caption ac-muted">
                          <code>{attribute.code}</code>
                        </span>
                      </div>
                    </td>
                    <td className="ac-text-body-s attributes-table__type">
                      {VALUE_TYPE_TEXT[attribute.valueType]}
                      {attribute.valueType === "number" && numberHint(attribute)
                        ? ` (${numberHint(attribute)})`
                        : ""}
                      {attribute.valueType === "enum"
                        ? ` · вариантов: ${attribute.options.filter((entry) => entry.status === "active").length}`
                        : ""}
                    </td>
                    <td className="ac-text-body-s nowrap">
                      <div className="cell-stack">
                        <span>{attribute.isFilterable ? "в фильтрах" : "не в фильтрах"}</span>
                        <span>
                          {attribute.isRequiredForComplete ? "в полноте" : "не в полноте"}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`status status--${attribute.status === "active" ? "open" : "closed"}`}
                      >
                        {attribute.status === "active" ? "Активна" : "В архиве"}
                      </span>
                    </td>
                    <td className="admin-table__actions">
                      <div className="button-row button-row--end">
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online}
                          onClick={() => setEditing({ attributeId: attribute.id })}
                        >
                          Изменить
                        </Button>
                        {attribute.valueType === "enum" && (
                          <Button
                            variant="secondary"
                            size="s"
                            onClick={() => setOptionsOf(attribute.id)}
                          >
                            Варианты
                          </Button>
                        )}
                        {attribute.status === "active" ? (
                          <Button
                            variant="text"
                            size="s"
                            disabled={!online}
                            onClick={() => setArchiving(attribute)}
                          >
                            В архив
                          </Button>
                        ) : (
                          <Button
                            variant="text"
                            size="s"
                            disabled={!online}
                            onClick={() => setStatus(attribute, "active")}
                          >
                            Восстановить
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LoadingContent>

      <AttributeDialog
        editing={editing}
        categoryId={category.id}
        current={byId(editing?.attributeId ?? null)}
        onReload={list.reload}
        onCancel={() => setEditing(null)}
        onSaved={(response, created) => {
          setEditing(null);
          toast.show("Сохранено");
          answered(response, created);
        }}
      />
      <OptionsDialog
        attribute={byId(optionsOf)}
        highlightOptionId={highlightOptionId}
        onClose={() => setOptionsOf(null)}
        onChanged={list.reload}
      />
      <Dialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title="Убрать характеристику в архив?"
        actions={
          <>
            <Button onClick={() => archiving && setStatus(archiving, "archived")}>В архив</Button>
            <Button variant="secondary" onClick={() => setArchiving(null)}>
              Отмена
            </Button>
          </>
        }
      >
        {archiving && (
          <div className="dialog-stack">
            <div className="was-now">
              <span className="was-now__line">
                <span className="ac-muted">«{ruText(archiving.names)}»:</span>
                <span className="was-now__value">Активна</span>→
                <span className="was-now__value was-now__value--new">В архиве</span>
              </span>
            </div>
            <p className="ac-text-body-s">
              Характеристика пропадёт из форм и фильтров; значения у позиций сохранятся, и её можно
              восстановить.
              {archiving.isRequiredForComplete
                ? " Она участвует в полноте и в том, чем товар отличается от другого: после архива некоторые товары могут совпасть — тогда здесь появится предупреждение."
                : ""}
            </p>
          </div>
        )}
      </Dialog>
    </div>
  );
}

interface AttributeForm {
  code: string;
  codeTouched: boolean;
  valueType: AttributeValueType;
  names: Names;
  unit: Names;
  integer: boolean;
  min: string;
  max: string;
  isFilterable: boolean;
  isRequiredForComplete: boolean;
}

const EMPTY_FORM: AttributeForm = {
  code: "",
  codeTouched: false,
  valueType: "enum",
  names: { ru: "", kk: "", en: "" },
  unit: { ru: "", kk: "", en: "" },
  integer: false,
  min: "",
  max: "",
  isFilterable: true,
  isRequiredForComplete: false,
};

function formOf(attribute: AdminAttribute): AttributeForm {
  return {
    code: attribute.code,
    codeTouched: true,
    valueType: attribute.valueType,
    names: {
      ru: attribute.names.ru?.text ?? "",
      kk: attribute.names.kk?.text ?? "",
      en: attribute.names.en?.text ?? "",
    },
    unit: {
      ru: attribute.unit?.ru?.text ?? "",
      kk: attribute.unit?.kk?.text ?? "",
      en: attribute.unit?.en?.text ?? "",
    },
    integer: attribute.number?.integer ?? false,
    min:
      attribute.number?.min !== null && attribute.number ? numberText(attribute.number.min!) : "",
    max:
      attribute.number?.max !== null && attribute.number ? numberText(attribute.number.max!) : "",
    isFilterable: attribute.isFilterable,
    isRequiredForComplete: attribute.isRequiredForComplete,
  };
}

function parseBound(text: string): number | null | "bad" {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : "bad";
}

function AttributeDialog({
  editing,
  categoryId,
  current,
  onReload,
  onCancel,
  onSaved,
}: {
  editing: { attributeId: string | null } | null;
  categoryId: string;
  current: AdminAttribute | null;
  onReload: () => void;
  onCancel: () => void;
  onSaved: (response: AdminAttributeResponse, created: boolean) => void;
}) {
  const [shown, setShown] = useState<{ attributeId: string | null } | null>(null);
  const [form, setForm] = useState<AttributeForm>(EMPTY_FORM);
  // The attribute as the dialog opened it: only what was changed against it is sent.
  const [opened, setOpened] = useState<AttributeForm>(EMPTY_FORM);
  const [error, setError] = useState<{
    text: string;
    field: string | null;
    conflict: boolean;
  } | null>(null);
  if (editing !== shown) {
    setShown(editing);
    setError(null);
    const start = current && editing?.attributeId ? formOf(current) : EMPTY_FORM;
    setForm(start);
    setOpened(start);
  }
  const creating = editing !== null && editing.attributeId === null;
  const code = form.codeTouched ? form.code : suggestCode(form.names.ru);
  const set = (patch: Partial<AttributeForm>) => setForm({ ...form, ...patch });

  const submit = async () => {
    if (!editing) return;
    if (!form.names.ru.trim()) {
      setError({ text: "Русское название обязательно", field: "names.ru", conflict: false });
      return;
    }
    const optional = (value: string) => (value.trim() ? value.trim() : null);
    const min = parseBound(form.min);
    const max = parseBound(form.max);
    if (form.valueType === "number" && (min === "bad" || max === "bad")) {
      setError({ text: "Границы — числа", field: "number", conflict: false });
      return;
    }
    const number =
      form.valueType === "number"
        ? { integer: form.integer, min: min as number | null, max: max as number | null }
        : undefined;
    const unit =
      form.valueType === "number" && form.unit.ru.trim()
        ? { ru: form.unit.ru.trim(), kk: optional(form.unit.kk), en: optional(form.unit.en) }
        : null;
    try {
      if (creating) {
        const response = await apiClient.createAttribute(
          { categoryId },
          {
            code,
            valueType: form.valueType,
            names: {
              ru: form.names.ru.trim(),
              kk: optional(form.names.kk),
              en: optional(form.names.en),
            },
            ...(form.valueType === "number" ? { unit, number } : {}),
            ...(form.valueType !== "text" ? { isFilterable: form.isFilterable } : {}),
            isRequiredForComplete: form.isRequiredForComplete,
          },
        );
        onSaved(response, true);
      } else if (current) {
        const before = opened;
        const nameChanges: { ru?: string; kk?: string | null; en?: string | null } = {};
        if (form.names.ru.trim() !== before.names.ru) nameChanges.ru = form.names.ru.trim();
        if (form.names.kk.trim() !== before.names.kk) nameChanges.kk = optional(form.names.kk);
        if (form.names.en.trim() !== before.names.en) nameChanges.en = optional(form.names.en);
        const unitChanged =
          form.unit.ru.trim() !== before.unit.ru ||
          form.unit.kk.trim() !== before.unit.kk ||
          form.unit.en.trim() !== before.unit.en;
        const numberChanged =
          form.integer !== before.integer || form.min !== before.min || form.max !== before.max;
        const response = await apiClient.updateAttribute(
          { attributeId: current.id },
          {
            expectedVersion: current.version,
            ...(Object.keys(nameChanges).length > 0 ? { names: nameChanges } : {}),
            ...(current.valueType === "number" && unitChanged ? { unit } : {}),
            ...(current.valueType === "number" && numberChanged && number ? { number } : {}),
            ...(current.valueType !== "text" && form.isFilterable !== before.isFilterable
              ? { isFilterable: form.isFilterable }
              : {}),
            ...(form.isRequiredForComplete !== before.isRequiredForComplete
              ? { isRequiredForComplete: form.isRequiredForComplete }
              : {}),
          },
        );
        onSaved(response, false);
      }
    } catch (thrown) {
      if (isConflict(thrown)) {
        const who = current ? await whoChanged("catalog_attribute", current.id) : null;
        setError({ text: conflictText(who), field: null, conflict: true });
      } else {
        setError({ text: catalogErrorText(thrown), field: errorField(thrown), conflict: false });
      }
    }
  };

  const fieldError = (field: string) => (error?.field === field ? error.text : undefined);

  return (
    <Dialog
      open={editing !== null}
      onClose={onCancel}
      title={creating ? "Новая характеристика" : "Изменить характеристику"}
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
        <TextField
          label="Русское название"
          value={form.names.ru}
          onChange={(ru) => set({ names: { ...form.names, ru } })}
          error={fieldError("names.ru")}
        />
        <TextField
          label="Казахское"
          value={form.names.kk}
          onChange={(kk) => set({ names: { ...form.names, kk } })}
          error={fieldError("names.kk")}
          hint="Пусто — переведёт ИИ; написанное здесь ИИ не затрёт"
        />
        <TextField
          label="Английское"
          value={form.names.en}
          onChange={(en) => set({ names: { ...form.names, en } })}
          error={fieldError("names.en")}
        />
        {creating && (
          <>
            <TextField
              label="Код"
              value={code}
              onChange={(value) => set({ code: value, codeTouched: true })}
              hint="Латиницей, не меняется после создания"
              error={fieldError("code")}
              autoComplete="off"
            />
            <label className="select">
              <span className="ac-text-caption ac-muted">Тип (не меняется после создания)</span>
              <select
                value={form.valueType}
                onChange={(event) => set({ valueType: event.target.value as AttributeValueType })}
              >
                {(Object.keys(VALUE_TYPE_TEXT) as AttributeValueType[]).map((type) => (
                  <option key={type} value={type}>
                    {VALUE_TYPE_TEXT[type]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {!creating && current && (
          <p className="ac-text-body-s ac-muted">
            Тип — {VALUE_TYPE_TEXT[current.valueType].toLowerCase()}, код{" "}
            <code>{current.code}</code>: не меняются. Нужен другой тип — уберите характеристику в
            архив и создайте новую.
          </p>
        )}
        {form.valueType === "number" && (
          <>
            <div className="field-row">
              <TextField
                label="Единица (рус.)"
                value={form.unit.ru}
                onChange={(ru) => set({ unit: { ...form.unit, ru } })}
                hint="мм, л, А·ч"
              />
              <TextField
                label="Единица (каз.)"
                value={form.unit.kk}
                onChange={(kk) => set({ unit: { ...form.unit, kk } })}
              />
              <TextField
                label="Единица (англ.)"
                value={form.unit.en}
                onChange={(en) => set({ unit: { ...form.unit, en } })}
              />
            </div>
            <div className="field-row">
              <TextField
                label="Не меньше"
                value={form.min}
                onChange={(min) => set({ min })}
                error={fieldError("number")}
              />
              <TextField label="Не больше" value={form.max} onChange={(max) => set({ max })} />
            </div>
            <Checkbox
              label="Только целые"
              checked={form.integer}
              onChange={(integer) => set({ integer })}
            />
          </>
        )}
        {form.valueType !== "text" && (
          <Checkbox
            label="Использовать в фильтрах"
            checked={form.isFilterable}
            onChange={(isFilterable) => set({ isFilterable })}
          />
        )}
        <Checkbox
          label="Участвует в полноте"
          description="Пустое значение помечает позицию неполной; для товаров по характеристикам — ещё и отличает товар от другого"
          checked={form.isRequiredForComplete}
          onChange={(isRequiredForComplete) => set({ isRequiredForComplete })}
        />
        {creating && form.valueType === "enum" && (
          <p className="ac-text-body-s ac-muted">
            Варианты списка добавляются после создания — кнопкой «Варианты».
          </p>
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

function OptionsDialog({
  attribute,
  highlightOptionId,
  onClose,
  onChanged,
}: {
  attribute: AdminAttribute | null;
  highlightOptionId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const online = useOnline();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminAttributeOption | "new" | null>(null);
  const [names, setNames] = useState<Names>({ ru: "", kk: "", en: "" });
  const [code, setCode] = useState<string | null>(null);
  const options = attribute?.options ?? [];

  const fail = async (thrown: unknown, entityType: string, entityId: string) => {
    if (isConflict(thrown)) {
      setError(conflictText(await whoChanged(entityType, entityId)));
      onChanged();
    } else {
      setError(catalogErrorText(thrown));
    }
  };

  const move = async (index: number, by: -1 | 1) => {
    if (!attribute) return;
    const body = optionOrderBody(options, index, by);
    if (!body) return;
    setError(null);
    try {
      await apiClient.reorderAttributeOptions({ attributeId: attribute.id }, body);
      onChanged();
    } catch (thrown) {
      await fail(thrown, "catalog_attribute_option", attribute.id);
    }
  };

  const setStatus = async (option: AdminAttributeOption, status: "active" | "archived") => {
    setError(null);
    try {
      await apiClient.setAttributeOptionStatus(
        { optionId: option.id },
        { status, expectedVersion: option.version },
      );
      onChanged();
    } catch (thrown) {
      await fail(thrown, "catalog_attribute_option", option.id);
    }
  };

  const openEdit = (option: AdminAttributeOption | "new") => {
    setEditing(option);
    setCode(null);
    setError(null);
    setNames(
      option === "new"
        ? { ru: "", kk: "", en: "" }
        : {
            ru: option.names.ru?.text ?? "",
            kk: option.names.kk?.text ?? "",
            en: option.names.en?.text ?? "",
          },
    );
  };

  const save = async () => {
    if (!attribute || !editing) return;
    if (!names.ru.trim()) {
      setError("Русское название обязательно");
      return;
    }
    const optional = (value: string) => (value.trim() ? value.trim() : null);
    try {
      if (editing === "new") {
        await apiClient.createAttributeOption(
          { attributeId: attribute.id },
          {
            code: code ?? suggestCode(names.ru, false),
            names: { ru: names.ru.trim(), kk: optional(names.kk), en: optional(names.en) },
          },
        );
      } else {
        await apiClient.updateAttributeOption(
          { optionId: editing.id },
          {
            expectedVersion: editing.version,
            names: { ru: names.ru.trim(), kk: optional(names.kk), en: optional(names.en) },
          },
        );
      }
      setEditing(null);
      onChanged();
    } catch (thrown) {
      await fail(thrown, "catalog_attribute_option", editing === "new" ? attribute.id : editing.id);
    }
  };

  return (
    <Dialog
      open={attribute !== null}
      onClose={() => {
        setEditing(null);
        setError(null);
        onClose();
      }}
      title={attribute ? `Варианты «${ruText(attribute.names)}»` : "Варианты"}
      actions={
        <Button
          variant="secondary"
          onClick={() => {
            setEditing(null);
            setError(null);
            onClose();
          }}
        >
          Готово
        </Button>
      }
    >
      <div className="dialog-stack">
        {options.length === 0 && <p className="ac-text-body-s ac-muted">Вариантов пока нет.</p>}
        <ol className="option-list">
          {options.map((option, index) => (
            <li
              key={option.id}
              className={[
                "option-row",
                option.status === "archived" ? "row--muted" : "",
                option.id === highlightOptionId ? "row--highlight" : "",
              ].join(" ")}
            >
              <span className="button-row">
                <IconButton
                  icon="arrowLeft"
                  className="arrow-up"
                  label={`Выше: ${ruText(option.names)}`}
                  disabled={!online || index === 0}
                  onClick={() => move(index, -1)}
                />
                <IconButton
                  icon="arrowLeft"
                  className="arrow-down"
                  label={`Ниже: ${ruText(option.names)}`}
                  disabled={!online || index === options.length - 1}
                  onClick={() => move(index, 1)}
                />
              </span>
              <span className="cell-stack option-row__name">
                <span className="ac-text-body-s">
                  {ruText(option.names)}
                  {option.status === "archived" ? " · в архиве" : ""}
                </span>
                <TextsLine texts={option.names} />
              </span>
              <span className="button-row">
                <Button variant="text" size="s" disabled={!online} onClick={() => openEdit(option)}>
                  Изменить
                </Button>
                <Button
                  variant="text"
                  size="s"
                  disabled={!online}
                  onClick={() =>
                    setStatus(option, option.status === "active" ? "archived" : "active")
                  }
                >
                  {option.status === "active" ? "В архив" : "Восстановить"}
                </Button>
              </span>
            </li>
          ))}
        </ol>
        {editing ? (
          <div className="localized-fields">
            <TextField
              label="Русский"
              value={names.ru}
              onChange={(ru) => setNames({ ...names, ru })}
            />
            <TextField
              label="Казахский"
              value={names.kk}
              onChange={(kk) => setNames({ ...names, kk })}
            />
            <TextField
              label="Английский"
              value={names.en}
              onChange={(en) => setNames({ ...names, en })}
            />
            {editing === "new" && (
              <TextField
                label="Код"
                value={code ?? suggestCode(names.ru, false)}
                onChange={setCode}
                hint="Латиницей, не меняется: ceramic, 5w_30"
                autoComplete="off"
              />
            )}
            <div className="button-row">
              <Button size="s" onClick={save}>
                {editing === "new" ? "Добавить вариант" : "Сохранить вариант"}
              </Button>
              <Button variant="text" size="s" onClick={() => setEditing(null)}>
                Отмена
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="s"
            icon="plus"
            disabled={!online}
            onClick={() => openEdit("new")}
          >
            Добавить вариант
          </Button>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
