import type { SupplierOrder, SupplierOrderTermOptions } from "@adclub/contracts";
import { Banner, Button, Chip, Dialog, SkeletonList, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { refreshCompany } from "../cabinet/cabinet-store";
import { useLanguage } from "../i18n";
import { formatDate, formatTermDay, proposeProblem } from "./order-rules";

/** The order another term is proposed for: what the card has. */
export interface TermTarget {
  id: string;
  number: number;
  version: number;
}

/** The dates of one order; another order's (or none yet) reads as loading. */
type Options =
  | { status: "loading" }
  | { status: "failed"; orderId: string }
  | { status: "ready"; orderId: string; options: SupplierOrderTermOptions };

/**
 * S-ORD-04 «Другой срок» (TASK-039): the working days of the company's
 * point to choose from — the server's list (`…/term-options`), the cabinet
 * counts no working days itself — «Клиент должен ответить до {время}. Если
 * не ответит — заявка отменится» and «Отправить клиенту». The date chosen
 * is sent as it is: the server proposes exactly it, or refuses it at the
 * field (the day turned meanwhile) and the dates are loaded again. A
 * colleague or the button of WhatsApp that was first closes the dialog with
 * the notice of the card («Заявку уже принял …»).
 */
export function TermDialog({
  target,
  onClose,
  onProposed,
  onProblem,
  format,
}: {
  /** `null` — the dialog is closed. */
  target: TermTarget | null;
  onClose: () => void;
  onProposed: (order: SupplierOrder) => void;
  onProblem: (problem: { conflict: boolean; text: string }) => void;
  format: (iso: string) => string;
}) {
  const { t, lang } = useLanguage();
  const toast = useToast();
  const online = useOnline();
  const [loaded, setLoaded] = useState<Options>({ status: "loading" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const orderId = target?.id ?? null;

  // The state is set only once the server answered: until then the dates of
  // this order are «loading» by their own absence (`options` below).
  const load = (id: string) =>
    apiClient.getSupplierOrderTermOptions({ orderId: id }).then(
      (answer) => setLoaded({ status: "ready", orderId: id, options: answer }),
      () => setLoaded({ status: "failed", orderId: id }),
    );
  const reload = (id: string) => {
    setLoaded({ status: "loading" });
    void load(id);
  };

  // The dates are asked for each time the dialog opens: a day may have turned
  // since. The choice and the error were cleared when it closed.
  useEffect(() => {
    if (orderId === null) return;
    void apiClient.getSupplierOrderTermOptions({ orderId }).then(
      (answer) => setLoaded({ status: "ready", orderId, options: answer }),
      () => setLoaded({ status: "failed", orderId }),
    );
  }, [orderId]);

  const close = () => {
    setChosen(null);
    setError(null);
    onClose();
  };

  const send = async () => {
    if (!target || chosen === null) return;
    setError(null);
    setSending(true);
    try {
      const { order } = await apiClient.proposeSupplierOrderTerm(
        { orderId: target.id },
        { expectedVersion: target.version, readyOn: chosen },
      );
      onProposed(order);
      toast.show(t("orders.termProposedToast", { number: target.number }));
      close();
    } catch (thrown) {
      const problem = proposeProblem(thrown, format, t);
      if (problem.companyChanged) void refreshCompany();
      if (problem.stale) {
        setChosen(null);
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

  const options: Options =
    loaded.status !== "loading" && loaded.orderId === orderId ? loaded : { status: "loading" };
  const ready = options.status === "ready" ? options.options : null;

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t("orders.termDialog.title")}
      actions={
        <>
          <Button variant="secondary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!online || chosen === null || sending} loading={sending} onClick={send}>
            {t("orders.termDialog.send")}
          </Button>
        </>
      }
    >
      <div className="stack-s">
        <p className="ac-muted">{t("orders.termDialog.hint")}</p>
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
            {t("orders.termDialog.loadFailed")}
          </Banner>
        )}
        {ready && (
          <>
            {ready.confirm.readyOn && (
              <p className="ac-text-body-s">
                {t("orders.termDialog.agreed", {
                  date: formatDate(ready.confirm.readyOn, lang),
                })}
              </p>
            )}
            {ready.options.length === 0 ? (
              <Banner tone="warning">{t("orders.termDialog.empty")}</Banner>
            ) : (
              <fieldset className="term-dates">
                <legend className="ac-text-caption ac-muted">{t("orders.termDialog.dates")}</legend>
                <div className="term-dates__grid">
                  {ready.options.map((option) => (
                    <Chip
                      key={option.readyOn}
                      selected={chosen === option.readyOn}
                      onClick={() => setChosen(option.readyOn)}
                    >
                      {formatTermDay(option.readyOn, lang)}
                    </Chip>
                  ))}
                </div>
              </fieldset>
            )}
            <p className="ac-text-body-s">
              {t("orders.termDialog.answerBy", { time: format(ready.answerBy) })}
            </p>
          </>
        )}
        {!online && <Banner icon="wifiOff">{t("common.needNetwork")}</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  );
}
