import type { PhoneRevealSubject } from "@adclub/contracts";
import { Button } from "@adclub/ui";
import { formatPhone, useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { revealErrorText } from "./people-words";

/**
 * A person's number as the admin panel shows it (SCREENS 7.0; TASK-036.B):
 * partly hidden, as the server sent it, and «Показать номер» — a request of
 * its own, written to the journal by the server (who opened whose number,
 * never the number). The full number lives only in this component's state:
 * not in the address, the history, the storage or the console, and it is
 * gone when the page is left.
 */
export function PhoneReveal({
  phone,
  subject,
  id,
}: {
  /** The number partly hidden, as the server sent it. */
  phone: string;
  subject: PhoneRevealSubject;
  id: string;
}) {
  const online = useOnline();
  const [shown, setShown] = useState<{ id: string; phone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = shown && shown.id === id ? shown.phone : null;

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await apiClient.revealPhone({ subject, id });
      setShown({ id, phone: answer.phone });
    } catch (thrown) {
      setError(revealErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="phone-reveal">
      <span className="num phone-reveal__number">{full ? formatPhone(full) : phone}</span>
      {full ? (
        <a className="ac-text-body-s" href={`tel:${full}`}>
          Позвонить
        </a>
      ) : (
        <Button variant="text" size="s" onClick={reveal} loading={busy} disabled={!online}>
          Показать номер
        </Button>
      )}
      {error && (
        <span className="ac-text-caption phone-reveal__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
