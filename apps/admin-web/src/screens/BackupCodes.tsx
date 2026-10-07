import { Banner, Button, Checkbox, useToast } from "@adclub/ui";
import { useState } from "react";
import { backupCodesFile } from "../security/backup-codes";

/**
 * The backup codes, shown once (A-AUTH; SCREENS 7.0 «Безопасность»): the
 * server keeps only a form they can't be read back from. They live in this
 * component's memory only — never in the address, the history or the
 * browser's storage — and go when it does. «Скачать как .txt» makes the file
 * in the page; nothing leaves it but the download.
 */
export function BackupCodes({
  codes,
  onDone,
  doneLabel = "Войти в админку",
}: {
  codes: readonly string[];
  onDone: () => void;
  doneLabel?: string;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopyFailed(false);
      toast.show("Коды скопированы");
    } catch {
      setCopyFailed(true);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(
      new Blob([backupCodesFile(codes, new Date())], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "asia-drive-club-admin-backup-codes.txt";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    // The file is the browser's now; the page keeps nothing.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="auth-stack">
      <h1 className="ac-text-title">Резервные коды</h1>
      <Banner tone="warning">
        Сохраните коды в надёжном месте, больше они не покажутся. Каждый код можно использовать один
        раз — если телефона с приложением-аутентификатором не окажется под рукой.
      </Banner>
      <ol className="backup-codes" aria-label="Резервные коды">
        {codes.map((code) => (
          <li key={code} className="backup-codes__code num">
            {code}
          </li>
        ))}
      </ol>
      <div className="button-row">
        <Button variant="secondary" icon="copy" onClick={copy}>
          Скопировать
        </Button>
        <Button variant="secondary" icon="download" onClick={download}>
          Скачать как .txt
        </Button>
      </div>
      {copyFailed && (
        <p className="ac-text-caption ac-muted">
          Браузер не дал скопировать. Выделите коды и скопируйте вручную или скачайте файл.
        </p>
      )}
      <Checkbox label="Я сохранил коды" checked={saved} onChange={setSaved} />
      <Button size="l" block disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
