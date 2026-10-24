import { Button, Dialog, TextAreaField } from "@adclub/ui";
import { useState, type ReactNode } from "react";

/**
 * A decision with a required reason or comment («Скрыть…», «Решить…»): what
 * happens, the field (our `TextAreaField`, no browser resizer — X2) and the
 * confirmation; the reason is checked here as the server checks it.
 */
export function ReasonDialog({
  open,
  title,
  confirm,
  onConfirm,
  onClose,
  busy,
  error,
  reasonLabel = "Причина (обязательно, попадёт в журнал)",
  maxLength = 500,
  children,
}: {
  open: boolean;
  title: string;
  confirm: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  busy: boolean;
  error: ReactNode;
  reasonLabel?: string;
  maxLength?: number;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setReason("");
      setProblem(null);
    }
  }
  const submit = () => {
    const text = reason.trim();
    if (text.length < 3) {
      setProblem("Укажите причину — не короче трёх знаков");
      return;
    }
    if (text.length > maxLength) {
      setProblem(`Не длиннее ${maxLength.toLocaleString("ru-RU")} знаков`);
      return;
    }
    onConfirm(text);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button onClick={submit} loading={busy}>
            {confirm}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        {children}
        <TextAreaField
          label={reasonLabel}
          value={reason}
          rows={3}
          maxLength={maxLength}
          onChange={(value) => {
            setReason(value);
            setProblem(null);
          }}
          error={problem ?? undefined}
        />
        {error}
      </div>
    </Dialog>
  );
}
