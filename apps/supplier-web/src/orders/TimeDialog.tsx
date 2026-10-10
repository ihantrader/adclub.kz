import type { SupplierOrder, SupplierOrderTimeOptions } from "@adclub/contracts";
import { visitInstant, visitSlots } from "@adclub/domain";
import { Banner, Button, Chip, Dialog, SkeletonList, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { refreshCompany } from "../cabinet/cabinet-store";
import { useLanguage } from "../i18n";
import { formatTermDay, proposeTimeProblem } from "./order-rules";

/** The order another time is proposed for: what the card has. */
export interface TimeTarget {
  id: string;
  number: number;
  version: number;
}

/** The times of one order; another order's (or none yet) reads as loading. */
type Options =
  | { status: "loading" }
  | { status: "failed"; orderId: string }
  | { status: "ready"; orderId: string; options: SupplierOrderTimeOptions };

interface Choice {
  date: string;
  time: string | null;
}

/**
 * S-ORD-04 «Другое время» of an order on a service (TASK-039.B): the
 * working days of the company's point and their hours — the server's list
 * (`…/time-options`), the cabinet counts no hours itself; the times are
 * those hours every half hour (`visitSlots`, the same as the app's), without
 * the time the customer asked for (that one is «Подтвердить»). «Клиент
 * должен ответить до {время}. Если не ответит — заявка отменится» and
 * «Отправить клиенту». A time the server no longer takes (the minute passed,
 * the point closed that day) is said at the times, which are loaded again; a
 * colleague or the button of WhatsApp that was first closes the dialog with
 * the notice of the card.
 */
export function TimeDialog({
  target,
  onClose,
  onProposed,
  onProblem,
  format,
}: {
  /** `null` — the dialog is closed. */
  target: TimeTarget | null;
  onClose: () => void;
  onProposed: (order: SupplierOrder) => void;
  onProblem: (problem: { conflict: boolean; text: string }) => void;
  format: (iso: string) => string;
}) {
  const { t, lang } = useLanguage();
  const toast = useToast();
  const online = useOnline();
  const [loaded, setLoaded] = useState<Options>({ status: "loading" });
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const orderId = target?.id ?? null;

  const load = (id: string) =>
    apiClient.getSupplierOrderTimeOptions({ orderId: id }).then(
      (answer) => setLoaded({ status: "ready", orderId: id, options: answer }),
      () => setLoaded({ status: "failed", orderId: id }),
    );
  const reload = (id: string) => {
    setLoaded({ status: "loading" });
    void load(id);
  };

  // The times are asked for each time the dialog opens: the hours of today
  // shrink by the minute. The choice and the error were cleared when it closed.
  useEffect(() => {
    if (orderId === null) return;
    void apiClient.getSupplierOrderTimeOptions({ orderId }).then(
      (answer) => setLoaded({ status: "ready", orderId, options: answer }),
      () => setLoaded({ status: "failed", orderId }),
    );
  }, [orderId]);

  const close = () => {
    setChosen(null);
    setError(null);
    onClose();
  };

  const options: Options =
    loaded.status !== "loading" && loaded.orderId === orderId ? loaded : { status: "loading" };
  const ready = options.status === "ready" ? options.options : null;
  const desired = ready ? Date.parse(ready.desiredAt) : null;
  // Each day with the times another visit may be at — the one asked for left out.
  const days = (ready?.days ?? [])
    .map((day) => ({
      date: day.date,
      times: visitSlots(day.intervals).filter(
        (time) => Date.parse(visitInstant(day.date, time, ready!.timeZone)) !== desired,
      ),
    }))
    .filter((day) => day.times.length > 0);
  const day = days.find((entry) => entry.date === chosen?.date) ?? days[0] ?? null;
  const time = day && chosen?.date === day.date ? chosen.time : null;
  // The customer answers by the server's moment — or by the proposed time
  // itself, if that comes first (ARCHITECTURE 4.62 I641, `timeAnswerBy`).
  const chosenAt =
    ready && day && time !== null ? visitInstant(day.date, time, ready.timeZone) : null;
  const answerBy =
    ready && chosenAt !== null && Date.parse(chosenAt) < Date.parse(ready.answerBy)
      ? chosenAt
      : null;

  const send = async () => {
    if (!target || !ready || !day || time === null) return;
    setError(null);
    setSending(true);
    try {
      const { order } = await apiClient.proposeSupplierOrderTime(
        { orderId: target.id },
        {
          expectedVersion: target.version,
          visitAt: visitInstant(day.date, time, ready.timeZone),
        },
      );
      onProposed(order);
      toast.show(t("orders.timeProposedToast", { number: target.number }));
      close();
    } catch (thrown) {
      const problem = proposeTimeProblem(thrown, format, t);
      if (problem.companyChanged) void refreshCompany();
      if (problem.stale) {
        setChosen({ date: day.date, time: null });
        setError(problem.text);
        reload(target.id);
      } else if (problem.conflict) {
        close();
        onProblem(problem);
      } else {
        setError(problem.text);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t("orders.timeDialog.title")}
      actions={
        <>
          <Button variant="secondary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!online || time === null || sending} loading={sending} onClick={send}>
            {t("orders.termDialog.send")}
          </Button>
        </>
      }
    >
      <div className="stack-s">
        <p className="ac-muted">{t("orders.timeDialog.hint")}</p>
        {options.status === "loading" && <SkeletonList rows={2} label={t("common.loading")} />}
        {options.status === "failed" && (
          <Banner
            tone="danger"
            action={
              orderId ? (
                <Button variant="text" size="s" onClick={() => reload(orderId)}>
                  {t("common.retry")}
                </Button>
              ) : undefined
            }
          >
            {t("orders.timeDialog.loadFailed")}
          </Banner>
        )}
        {ready && (
          <>
            <p className="ac-text-body-s">
              {t("orders.visit.desired", { time: format(ready.desiredAt) })}
            </p>
            {days.length === 0 || !day ? (
              <Banner tone="warning">{t("orders.timeDialog.empty")}</Banner>
            ) : (
              <>
                <fieldset className="term-dates">
                  <legend className="ac-text-caption ac-muted">
                    {t("orders.timeDialog.days")}
                  </legend>
                  <div className="term-dates__grid term-dates__grid--short">
                    {days.map((entry) => (
                      <Chip
                        key={entry.date}
                        selected={day.date === entry.date}
                        onClick={() => setChosen({ date: entry.date, time: null })}
                      >
                        {formatTermDay(entry.date, lang)}
                      </Chip>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="term-dates">
                  <legend className="ac-text-caption ac-muted">
                    {t("orders.timeDialog.times")}
                  </legend>
                  <div className="term-dates__grid term-dates__grid--short">
                    {day.times.map((slot) => (
                      <Chip
                        key={slot}
                        selected={time === slot}
                        onClick={() => setChosen({ date: day.date, time: slot })}
                      >
                        {slot}
                      </Chip>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
            <p className="ac-text-body-s">
              {t("orders.termDialog.answerBy", { time: format(answerBy ?? ready.answerBy) })}
            </p>
          </>
        )}
        {!online && <Banner icon="wifiOff">{t("common.needNetwork")}</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  );
}
