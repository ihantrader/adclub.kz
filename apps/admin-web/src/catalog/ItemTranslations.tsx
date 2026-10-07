import type {
  AdminCatalogItemCard,
  EntityTranslationsResponse,
  TranslationField,
  TranslationLanguage,
  TranslationTargetLanguage,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  LoadingContent,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { useLoad } from "../use-load";
import { TRANSLATION_FAILURE_TEXT, catalogErrorText } from "./catalog-words";

const LANGUAGES = [
  { code: "ru", label: "Русский" },
  { code: "kk", label: "Казахский" },
  { code: "en", label: "Английский" },
] as const;

const FIELD_TEXT: Record<TranslationField, string> = { name: "Название", unit: "Единица" };

/** Where a text came from, in words (SCREENS A-CAT-05 «Переводы»). */
export function sourceText(language: TranslationLanguage, isSource: boolean): string {
  const text = language.translation;
  if (isSource) return "исходный текст";
  if (!text) return "нет перевода";
  if (text.origin === "manual") return "вручную — ИИ его не затрёт";
  if (text.origin === "ai") return text.aiModel ? `ИИ · ${text.aiModel}` : "ИИ";
  return "исходный";
}

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
      {data.error !== undefined && <Banner tone="danger">{loadErrorText(data.error)}</Banner>}
      <LoadingContent
        ready={data.data !== undefined}
        indicator={data.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {(data.data?.fields ?? []).map((view) => (
          <div key={view.field} className="card-section">
            <h3 className="ac-text-heading">{FIELD_TEXT[view.field]}</h3>
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Язык</th>
                    <th scope="col">Текст</th>
                    <th scope="col">Источник</th>
                    <th scope="col" className="admin-table__actions">
                      Действия
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {LANGUAGES.map(({ code, label }) => {
                    const language = view.texts[code];
                    const text = language.translation;
                    const isSource = code === "ru";
                    const task = language.task;
                    const manual = text?.origin === "manual";
                    return (
                      <tr key={code}>
                        <td className="ac-text-body-s nowrap">{label}</td>
                        <td>
                          <div className="cell-stack">
                            <span className="long-text">
                              {text?.text ?? <span className="ac-muted">—</span>}
                            </span>
                            {text?.isSourceChanged && (
                              <span className="warning-text ac-text-caption">
                                Русский текст изменился после этого перевода
                              </span>
                            )}
                            {task?.state === "queued" && (
                              <span className="ac-text-caption ac-muted">
                                Ждёт автоперевода
                                {task.attempts > 0 ? ` (неудачных попыток: ${task.attempts})` : ""}
                              </span>
                            )}
                            {task?.state === "failed" && (
                              <span className="warning-text ac-text-caption">
                                Автоперевод отказан:{" "}
                                {task.failure
                                  ? TRANSLATION_FAILURE_TEXT[task.failure]
                                  : "без причины"}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="ac-text-body-s">
                          <div className="cell-stack">
                            <span>{sourceText(language, isSource)}</span>
                            {text && (
                              <span className="ac-text-caption ac-muted">
                                {formatMoment(text.updatedAt)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="admin-table__actions">
                          {isSource ? (
                            <span className="ac-text-caption ac-muted">во вкладке «Основное»</span>
                          ) : (
                            <div className="button-row button-row--end">
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
                              {!manual && (
                                <Button
                                  variant="text"
                                  size="s"
                                  disabled={!online}
                                  onClick={() =>
                                    act(
                                      () => apiClient.retranslate(target(view.field, code)),
                                      "Перевод поставлен в очередь",
                                    )
                                  }
                                >
                                  Перевести заново
                                </Button>
                              )}
                              {manual && (
                                <Button
                                  variant="text"
                                  size="s"
                                  disabled={!online}
                                  onClick={() =>
                                    act(
                                      () => apiClient.releaseTranslation(target(view.field, code)),
                                      "Ручная правка снята, язык снова переводит ИИ",
                                    )
                                  }
                                >
                                  Снять ручную правку
                                </Button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
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
