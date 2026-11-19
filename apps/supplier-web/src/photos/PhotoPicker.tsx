import { PHOTO_CONTENT_TYPES } from "@adclub/contracts";
import { Button } from "@adclub/ui";
import { useRef } from "react";
import { useT } from "../i18n";

/**
 * «Сфотографировать» and «Выбрать файл» (TASK-068; S-OFF-03, S-OFF-05): on a
 * phone the first opens the camera (`<input capture>`), the second the
 * gallery or files; on a computer both choose a file. One photo at a time.
 */
export function PhotoPicker({
  disabled,
  busy,
  onPhoto,
  testId,
}: {
  disabled?: boolean;
  busy?: boolean;
  onPhoto: (file: File) => void;
  testId: string;
}) {
  const t = useT();
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const take = (input: HTMLInputElement | null) => {
    const file = input?.files?.[0];
    if (input) input.value = "";
    if (file) onPhoto(file);
  };
  return (
    <span className="photo-picker">
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid={`${testId}-camera`}
        onChange={(event) => take(event.currentTarget)}
      />
      <input
        ref={files}
        type="file"
        accept={PHOTO_CONTENT_TYPES.join(",")}
        hidden
        data-testid={`${testId}-file`}
        onChange={(event) => take(event.currentTarget)}
      />
      <Button
        icon="camera"
        variant="secondary"
        disabled={disabled}
        loading={busy}
        onClick={() => camera.current?.click()}
      >
        {t("photo.take")}
      </Button>
      <Button variant="text" disabled={disabled || busy} onClick={() => files.current?.click()}>
        {t("photo.choose")}
      </Button>
    </span>
  );
}
