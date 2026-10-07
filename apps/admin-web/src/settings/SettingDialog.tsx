import { isApiError } from "@adclub/api-client";
import type { Setting, SettingChangedResponse } from "@adclub/contracts";
import { Banner, Button, Checkbox, Dialog, TextField, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { actionErrorText, validationText } from "../errors";
import {
  editorOf,
  formatValue,
  inputOf,
  parseInput,
  rangeText,
  reasonProblem,
  sameValue,
  settingActorText,
  type LocalizedInput,
  type SettingInput,
} from "./setting-rules";

/**
 * The change of one setting (A-SET-01, A-SET-02; SCREENS 7.0): the field by
 * the type, the check of range and form before anything is sent, «было →
 * стало» and the required reason; «Вернуть по умолчанию» the same way. The
 * version the dialog was opened with goes along: when a colleague changed
 * the setting meanwhile, the server refuses, the dialog says who it was —
 * «Эти данные только что изменил {администратор}. Обновите страницу» — and
 * keeps what was typed; «Обновить» takes the fresh value and version.
 */
export function SettingDialog({
  setting,
  onCancel,
  onSaved,
  reloadSetting,
}: {
  setting: Setting | null;
  onCancel: () => void;
  onSaved: (setting: Setting) => void;
  /** The setting as the server has it now (after a conflict). */
  reloadSetting: (key: string) => Promise<Setting | null>;
}) {
  const toast = useToast();
  const online = useOnline();
  const [base, setBase] = useState<Setting | null>(null);
  const [input, setInput] = useState<SettingInput>("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"edit" | "reset">("edit");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // A newly opened setting starts from its value; a reload keeps what was typed.
  if (setting && base?.key !== setting.key) {
    setBase(setting);
    setInput(inputOf(setting));
    setReason("");
    setMode("edit");
    setError(null);
    setConflict(null);
    setTouched(false);
  }
  if (!setting && base) setBase(null);

  const current = base;
  const parsed = current ? parseInput(current, input) : null;
  const target = mode === "reset" ? current?.defaultValue : parsed?.ok ? parsed.value : undefined;
  const unchanged = current !== null && target !== undefined && sameValue(current.value, target);
  const reasonError = reasonProblem(reason);

  const submit = async () => {
    if (!current) return;
    setTouched(true);
    if (mode === "edit" && (!parsed || !parsed.ok)) return;
    if (unchanged || reasonError) return;
    setError(null);
    try {
      let answer: SettingChangedResponse;
      if (mode === "reset") {
        answer = await apiClient.resetSetting(
          { key: current.key },
          { expectedVersion: current.version, reason: reason.trim() },
        );
      } else {
        answer = await apiClient.changeSetting(
          { key: current.key },
          {
            value: (parsed as { value: unknown }).value,
            expectedVersion: current.version,
            reason: reason.trim(),
          },
        );
      }
      onSaved(answer.setting);
      toast.show(mode === "reset" ? "Возвращено значение по умолчанию" : "Сохранено");
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "SETTING_VERSION_CONFLICT") {
        const fresh = await reloadSetting(current.key).catch(() => null);
        const who = fresh?.lastChange
          ? settingActorText(fresh.lastChange.by)
          : "другой администратор";
        setConflict(`Эти данные только что изменил ${who}. Обновите страницу`);
        return;
      }
      if (isApiError(thrown) && thrown.code === "VALIDATION_ERROR") {
        const server = validationText(thrown);
        setError(
          current.constraints.maxVersion
            ? `Нельзя установить минимальную версию админки выше текущей версии. Ответ сервера: ${server ?? ""}`
            : `Сервер не принял значение: ${server ?? ""}`,
        );
        return;
      }
      setError(actionErrorText(thrown));
    }
  };

  const refresh = async () => {
    if (!current) return;
    const fresh = await reloadSetting(current.key).catch(() => null);
    if (fresh) {
      // The fresh value and version; what was typed stays in the field.
      setBase(fresh);
      setConflict(null);
    }
  };

  return (
    <Dialog
      open={setting !== null}
      onClose={onCancel}
      title={mode === "reset" ? "Вернуть по умолчанию" : "Изменить настройку"}
      actions={
        <>
          <Button onClick={submit} disabled={!online || conflict !== null}>
            {mode === "reset" ? "Вернуть по умолчанию" : "Сохранить"}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
        </>
      }
    >
      {current && (
        <div className="dialog-stack">
          <p className="ac-text-body">{current.description}</p>
          <p className="ac-text-caption ac-muted">
            <code>{current.key}</code>
            {rangeText(current) ? ` · ${rangeText(current)}` : ""} · по умолчанию{" "}
            {formatValue(current, current.defaultValue)}
          </p>

          {conflict && (
            <Banner
              tone="warning"
              action={
                <Button variant="text" size="s" onClick={refresh}>
                  Обновить
                </Button>
              }
            >
              {conflict}
            </Banner>
          )}

          {mode === "edit" && (
            <Field
              setting={current}
              input={input}
              onChange={(next) => {
                setInput(next);
                setError(null);
              }}
              error={touched && parsed && !parsed.ok ? parsed.error : null}
            />
          )}

          <div className="was-now" aria-live="polite">
            <span className="ac-text-caption ac-muted">Было → стало</span>
            <span className="was-now__line">
              <span className="was-now__value">{formatValue(current, current.value)}</span>
              <span aria-hidden="true">→</span>
              <span className="was-now__value was-now__value--new">
                {target === undefined ? "…" : formatValue(current, target)}
              </span>
            </span>
            {unchanged && <span className="ac-text-caption ac-muted">Значение не меняется</span>}
          </div>

          <label className="textarea">
            <span className="ac-text-caption ac-muted">
              Причина (обязательно, попадёт в журнал)
            </span>
            <textarea
              value={reason}
              rows={2}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={touched && reasonError ? true : undefined}
            />
          </label>
          {touched && reasonError && <p className="dialog-error">{reasonError}</p>}
          {error && <p className="dialog-error">{error}</p>}

          {mode === "edit" && !current.isDefault && (
            <Button
              variant="text"
              size="s"
              onClick={() => {
                setMode("reset");
                setTouched(false);
              }}
            >
              Вернуть по умолчанию…
            </Button>
          )}
          {mode === "reset" && (
            <Button variant="text" size="s" onClick={() => setMode("edit")}>
              Изменить значение вместо этого
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Field({
  setting,
  input,
  onChange,
  error,
}: {
  setting: Setting;
  input: SettingInput;
  onChange: (next: SettingInput) => void;
  error: string | null;
}) {
  switch (editorOf(setting)) {
    case "boolean":
      return (
        <Checkbox
          label="Включено"
          checked={input === true}
          onChange={(checked) => onChange(checked)}
        />
      );
    case "enum":
      return (
        <label className="select">
          <span className="ac-text-caption ac-muted">Значение</span>
          <select value={String(input)} onChange={(event) => onChange(event.target.value)}>
            {(setting.constraints.allowedValues ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      );
    case "localized": {
      const text = input as LocalizedInput;
      return (
        <div className="localized-fields">
          {(["ru", "kk", "en"] as const).map((lang) => (
            <label key={lang} className="textarea">
              <span className="ac-text-caption ac-muted">
                {lang === "ru" ? "Русский" : lang === "kk" ? "Казахский" : "Английский"}
              </span>
              <textarea
                value={text[lang]}
                rows={3}
                onChange={(event) => onChange({ ...text, [lang]: event.target.value })}
              />
            </label>
          ))}
          {error && <p className="dialog-error">{error}</p>}
        </div>
      );
    }
    case "json":
      return (
        <label className="textarea">
          <span className="ac-text-caption ac-muted">Значение (JSON)</span>
          <textarea
            className="mono"
            value={String(input)}
            rows={8}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
          {error && <span className="dialog-error">{error}</span>}
        </label>
      );
    default:
      return (
        <TextField
          label={editorOf(setting) === "version" ? "Минимальная версия" : "Значение"}
          value={String(input)}
          onChange={onChange}
          inputMode={editorOf(setting) === "integer" ? "numeric" : undefined}
          error={error ?? undefined}
          hint={error ? undefined : (rangeText(setting) ?? undefined)}
          autoFocus
        />
      );
  }
}
