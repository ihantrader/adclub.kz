import type {
  AdminCatalogItemCard,
  EntityTranslationsResponse,
  TranslationField,
  TranslationTargetLanguage,
} from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  LoadingContent,
  MenuButton,
  SkeletonList,
  TextField,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { Table } from "../layout/layout";
import { useLoad } from "../use-load";
import { OriginMark } from "./catalog-ui";
import { TRANSLATION_FAILURE_TEXT, catalogErrorText } from "./catalog-words";

const LANGUAGES = [
  { code: "ru", label: "Русский" },
  { code: "kk", label: "Казахский" },
  { code: "en", label: "Английский" },
] as const;

const FIELD_TEXT: Record<TranslationField, string> = { name: "Название", unit: "Единица" };

const COLUMNS = [
  { key: "lang", header: "Язык", width: 110 },
  { key: "text", header: "Текст" },
  { key: "origin", header: "Источник", width: 170 },
  { key: "actions", header: "Действия", actions: true, hiddenHeader: true, width: 180 },
];

/**
 * «Переводы» of the card (A-CAT-05; TASK-012 on the server): every field in
 * kk/ru/en with its text and where it came from, «исходник изменился» for a
 * text made from an older Russian one, the waiting or refused automatic
 * translation with its reason; a hand-written text (automatic translation
 * never overwrites it), «Перевести заново» (for an AI, a missing or a
 * refused one) and «Снять ручную правку». The rules are the server's.
 */
export function ItemTranslations({
  card,
  onChanged,
}: {
  card: AdminCatalogItemCard;
  onChanged: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const itemId = card.item.id;
  const data = useLoad<EntityTranslationsResponse>(
    () => apiClient.getEntityTranslations({ entityType: "catalog_item", entityId: itemId }),
    `translations:${itemId}:${card.item.version}`,
  );
  const [editing, setEditing] = useState<{
    field: TranslationField;
    lang: TranslationTargetLanguage;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const target = (field: TranslationField, lang: TranslationTargetLanguage) => ({
    entityType: "catalog_item" as const,
    entityId: itemId,
    field,
    lang,
  });

  const act = async (action: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await action();
      toast.show(done);
      data.reload();
      onChanged();
    } catch (thrown) {
      setError(catalogErrorText(thrown));
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setDialogError(null);
    try {
      await apiClient.editTranslation(target(editing.field, editing.lang), {
        text: editing.text.trim(),
      });
      setEditing(null);
      toast.show("Перевод сохранён вручную");
      data.reload();
      onChanged();
    } catch (thrown) {
      setDialogError(catalogErrorText(thrown));
    }
  };

  return (
    <div className="detail-stack">
      {error && <Banner tone="warning">{error}</Banner>}
      {data.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={data.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(data.error)}
        </Banner>
      )}
      <LoadingContent
        ready={data.data !== undefined}
        indicator={data.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {(data.data?.fields ?? []).map((view) => (
          <section key={view.field} className="section">
            <div className="section__head">
              <h3 className="section__title">{FIELD_TEXT[view.field]}</h3>
            </div>
            <Table label={`Переводы: ${FIELD_TEXT[view.field]}`} columns={COLUMNS}>
              {LANGUAGES.map(({ code, label }) => {
                const language = view.texts[code];
                const text = language.translation;
                const isSource = code === "ru";
                const task = language.task;
                const manual = text?.origin === "manual";
                return (
                  <tr key={code}>
                    <td className="nowrap">{label}</td>
                    <td>
                      <div className="cell-stack">
                        <span className="long-text">
                          {text?.text ?? <span className="ac-muted">Нет текста</span>}
                        </span>
                        {text?.isSourceChanged && (
                          <Badge tone="warning" icon="alertTriangle">
                            Русский текст изменился после этого перевода
                          </Badge>
                        )}
                        {task?.state === "queued" && (
                          <TypeMark icon="clock">
                            Ждёт автоперевода
                            {task.attempts > 0 ? ` (неудачных попыток: ${task.attempts})` : ""}
                          </TypeMark>
                        )}
                        {task?.state === "failed" && (
                          <Badge tone="warning" icon="alertTriangle">
                            Автоперевод отказан:{" "}
                            {task.failure ? TRANSLATION_FAILURE_TEXT[task.failure] : "без причины"}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack">
                        <OriginMark text={text} source={isSource} />
                        {text?.origin === "ai" && text.aiModel && (
                          <span className="code-text" title="Модель ИИ">
                            {text.aiModel}
                          </span>
                        )}
                        {text && (
                          <span className="ac-text-caption ac-muted nowrap">
                            {formatMoment(text.updatedAt)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="admin-table__actions">
                      {isSource ? (
                        <span className="ac-text-caption ac-muted">Правится в «Основном»</span>
                      ) : (
                        <span className="row-actions">
                          <Button
                            variant="secondary"
                            size="s"
                            disabled={!online}
                            onClick={() => {
                              setDialogError(null);
                              setEditing({
                                field: view.field,
                                lang: code,
                                text: text?.text ?? "",
                              });
                            }}
                          >
                            Исправить
                          </Button>
                          <MenuButton
                            size="s"
                            label={`Перевод: ${label}`}
                            actions={[
                              manual
                                ? {
                                    key: "release",
                                    label: "Снять ручную правку",
                                    icon: "sparkles" as const,
                                    disabled: !online,
                                    onSelect: () =>
                                      void act(
                                        () =>
                                          apiClient.releaseTranslation(target(view.field, code)),
                                        "Ручная правка снята, язык снова переводит ИИ",
                                      ),
                                  }
                                : {
                                    key: "retranslate",
                                    label: "Перевести заново",
                                    icon: "refresh" as const,
                                    disabled: !online,
                                    onSelect: () =>
                                      void act(
                                        () => apiClient.retranslate(target(view.field, code)),
                                        "Перевод поставлен в очередь",
                                      ),
                                  },
                            ]}
                          />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          </section>
        ))}
      </LoadingContent>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing
            ? `${FIELD_TEXT[editing.field]}: ${editing.lang === "kk" ? "казахский" : "английский"}`
            : ""
        }
        actions={
          <>
            <Button onClick={saveEdit} disabled={!editing?.text.trim()}>
              Сохранить
            </Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Отмена
            </Button>
          </>
        }
      >
        {editing && (
          <div className="dialog-stack">
            <TextField
              label="Текст"
              value={editing.text}
              onChange={(text) => setEditing({ ...editing, text })}
              error={dialogError ?? undefined}
            />
            <p className="ac-text-body-s ac-muted">
              Текст станет ручным: автоперевод его не затрёт. Когда изменится русский текст, здесь
              появится отметка «исходник изменился» — тогда проверьте перевод.
            </p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
