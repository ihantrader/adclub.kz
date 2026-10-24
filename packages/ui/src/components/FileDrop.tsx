import type { IconName } from "@adclub/ui-core";
import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { cx } from "./cx";

/** Why a file is not taken: not one of `accept`, or larger than `maxBytes`. */
export type FileProblem = "type" | "size";

/**
 * Whether a file may be taken (TASK-080): `accept` lists extensions
 * («.csv») and media types («image/png», «image/*»), as the `accept` of a
 * file input; an empty list takes any file. The server checks the content
 * again — this only spares an upload that is sure to be refused.
 */
export function fileProblem(
  file: Pick<File, "name" | "type" | "size">,
  accept: readonly string[],
  maxBytes?: number,
): FileProblem | null {
  if (accept.length > 0) {
    const name = file.name.toLowerCase();
    const type = file.type.toLowerCase();
    const fits = accept.some((entry) => {
      const rule = entry.trim().toLowerCase();
      if (rule.startsWith(".")) return name.endsWith(rule);
      if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
      return type === rule;
    });
    if (!fits) return "type";
  }
  if (maxBytes !== undefined && file.size > maxBytes) return "size";
  return null;
}

/** «1,2 МБ», «640 КБ» — the size of a chosen file. */
export function fileSizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}\u00a0МБ`;
  }
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("ru-RU")}\u00a0КБ`;
}

export interface FileDropTexts {
  choose: string;
  /** The line under the button before a file is chosen. */
  none: string;
  wrongType: string;
  tooLarge: string;
}

const RUSSIAN: FileDropTexts = {
  choose: "Выбрать файл",
  none: "Файл не выбран",
  wrongType: "Этот файл не подходит — выберите файл нужного вида",
  tooLarge: "Файл слишком большой",
};

export interface FileDropProps {
  /** «Перетащите файл сюда или выберите» — what the zone takes. */
  title: ReactNode;
  /** The kinds and the size limit in words: «JPEG, PNG или WebP, до 10 МБ». */
  hint?: ReactNode;
  accept: readonly string[];
  maxBytes?: number;
  /** The chosen file shown by its name and size; `null` — «Файл не выбран». */
  file?: File | null;
  onFile: (file: File) => void;
  /** A file refused here; the zone shows `texts.wrongType` / `texts.tooLarge` itself. */
  onReject?: (problem: FileProblem, file: File) => void;
  disabled?: boolean;
  /** The server's word about the file (it is shown in place of the zone's own). */
  error?: ReactNode;
  /** Instead of the button while the file goes up: «Загружаем…» with its progress. */
  progress?: ReactNode;
  icon?: IconName;
  texts?: FileDropTexts;
  /** The action next to «Выбрать файл» once a file is chosen: «Загрузить и проверить». */
  action?: ReactNode;
}

/**
 * The zone of a file (TASK-080, X2): a file dropped on it (a computer) or
 * chosen by «Выбрать файл»; under the button — the chosen file's name or
 * «Файл не выбран»; a file of the wrong kind or too large is refused here
 * with its reason. The browser's own «Choose File» is never on screen: its
 * input is hidden and the button opens it. One for the cabinet's «Прайс»
 * and the admin panel's photos and imports.
 */
export function FileDrop({
  title,
  hint,
  accept,
  maxBytes,
  file,
  onFile,
  onReject,
  disabled,
  error,
  progress,
  icon = "upload",
  texts = RUSSIAN,
  action,
}: FileDropProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<FileProblem | null>(null);

  const take = (files: FileList | null) => {
    const chosen = files?.[0];
    if (input.current) input.current.value = "";
    if (!chosen) return;
    const found = fileProblem(chosen, accept, maxBytes);
    setProblem(found);
    if (found) onReject?.(found, chosen);
    else onFile(chosen);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setOver(false);
    if (!disabled && !progress) take(event.dataTransfer.files);
  };

  const shownError =
    error ?? (problem === "type" ? texts.wrongType : problem === "size" ? texts.tooLarge : null);
  return (
    <section
      className={cx(
        "ac-file-drop",
        over && "ac-file-drop--over",
        disabled && "ac-file-drop--disabled",
        shownError ? "ac-file-drop--error" : null,
      )}
      aria-labelledby={`${id}-title`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled && !progress) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <Icon name={icon} size={24} className="ac-file-drop__icon" />
      <div className="ac-file-drop__text">
        <p className="ac-file-drop__title" id={`${id}-title`}>
          {title}
        </p>
        {hint && <p className="ac-file-drop__hint">{hint}</p>}
      </div>
      {progress ? (
        <div className="ac-file-drop__progress" role="status">
          {progress}
        </div>
      ) : (
        <div className="ac-file-drop__choose">
          <div className="ac-file-drop__buttons">
            <Button
              variant="secondary"
              size="s"
              disabled={disabled}
              aria-describedby={`${id}-file`}
              onClick={() => input.current?.click()}
            >
              {texts.choose}
            </Button>
            {file && action}
          </div>
          <span
            className={cx("ac-file-drop__file", !file && "ac-file-drop__file--none")}
            id={`${id}-file`}
          >
            {file ? (
              <>
                <span className="ac-file-drop__name">{file.name}</span>
                <span className="ac-file-drop__size">{fileSizeText(file.size)}</span>
              </>
            ) : (
              texts.none
            )}
          </span>
        </div>
      )}
      {shownError && (
        <p className="ac-file-drop__error" role="alert">
          <Icon name="alertTriangle" size={16} />
          <span>{shownError}</span>
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept={accept.join(",")}
        className="ac-visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        data-testid="file-drop-input"
        onChange={(event) => take(event.target.files)}
      />
    </section>
  );
}
