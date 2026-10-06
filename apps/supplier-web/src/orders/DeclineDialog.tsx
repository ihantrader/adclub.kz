import type { OrderDeclineReason, SupplierOrder } from "@adclub/contracts";
import { ORDER_DECLINE_NOTE_MAX_LENGTH } from "@adclub/contracts";
import { Banner, Button, Dialog, Radio, TextField, useToast } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { refreshCompany } from "../cabinet/cabinet-store";
import { useOnline } from "../connection";
import { useT } from "../i18n";
import { offerProblem } from "../offers/offer-rules";
import { actionProblem, declineReasonKey } from "./order-rules";

/** The order a decline is asked for: what the list and the card both have. */
export interface DeclineTarget {
  id: string;
  number: number;
  version: number;
}

type Step =
  | { kind: "ask" }
  /** «Нет в наличии» and the offer still on sale: take it off sale too? */
  | { kind: "withdraw"; offerId: string; version: number };

const reasons: readonly (OrderDeclineReason | null)[] = [
  null,
  "out_of_stock",
  "cannot_meet_term",
  "other",
];

/**
 * S-ORD-03 «Отказать клиенту?»: a reason if the employee wants to give one
 * (the client never sees it), then — after «Нет в наличии» — «Снять это
 * предложение с продажи?», taken off sale the same way «Предложения» do
 * it (`withdrawOffer` of the answer; declining never withdraws by itself).
 */
export function DeclineDialog({
  target,
  onClose,
  onDeclined,
  onProblem,
  format,
}: {
  /** `null` — the dialog is closed. */
  target: DeclineTarget | null;
  onClose: () => void;
  /** The declined order, as the server answered. */
  onDeclined: (order: SupplierOrder) => void;
  /** The decline was refused: a conflict (the order moved) or an error. */
  onProblem: (problem: { conflict: boolean; text: string }) => void;
  format: (iso: string) => string;
}) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const [step, setStep] = useState<Step>({ kind: "ask" });
  const [reason, setReason] = useState<OrderDeclineReason | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setStep({ kind: "ask" });
    setReason(null);
    setNote("");
    setError(null);
    onClose();
  };

  const decline = async () => {
    if (!target) return;
    setError(null);
    try {
      const answer = await apiClient.declineSupplierOrder(
        { orderId: target.id },
        {
          expectedVersion: target.version,
          ...(reason && { reason }),
          ...(reason === "other" && note.trim() && { note: note.trim() }),
        },
      );
      onDeclined(answer.order);
      toast.show(t("orders.declinedToast", { number: target.number }));
      if (answer.withdrawOffer) {
        setStep({
          kind: "withdraw",
          offerId: answer.withdrawOffer.offerId,
          version: answer.withdrawOffer.version,
        });
      } else {
        close();
      }
    } catch (thrown) {
      const problem = actionProblem(thrown, format, t);
      if (problem.companyChanged) void refreshCompany();
      if (problem.conflict) {
        close();
        onProblem(problem);
      } else {
        setError(problem.text);
      }
    }
  };

  const withdraw = async (offerId: string, version: number) => {
    setError(null);
    try {
      await apiClient.withdrawSupplierOffer({ offerId }, { expectedVersion: version });
      toast.show(t("offers.withdrawn"));
      close();
    } catch (thrown) {
      const problem = offerProblem(thrown);
      setError(problem.conflict ? t("orders.withdrawConflict") : t(problem.key, problem.params));
    }
  };

  if (step.kind === "withdraw") {
    return (
      <Dialog
        open={target !== null}
        onClose={close}
        title={t("orders.withdrawTitle")}
        actions={
          <>
            <Button variant="secondary" onClick={close}>
              {t("orders.withdrawKeep")}
            </Button>
            <Button
              variant="danger"
              disabled={!online}
              onClick={() => withdraw(step.offerId, step.version)}
            >
              {t("offers.withdraw")}
            </Button>
          </>
        }
      >
        <div className="stack-s">
          <p>{t("orders.withdrawText")}</p>
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t("orders.declineTitle")}
      actions={
        <>
          <Button variant="secondary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={!online} onClick={decline}>
            {t("orders.decline")}
          </Button>
        </>
      }
    >
      <div className="stack-s">
        <p className="ac-muted">{t("orders.declineHint")}</p>
        <fieldset className="decline-reasons">
          <legend className="ac-visually-hidden">{t("orders.declineReason")}</legend>
          {reasons.map((value) => (
            <Radio
              key={value ?? "none"}
              name="decline-reason"
              label={t(value ? declineReasonKey(value) : "orders.decline.none")}
              checked={reason === value}
              onChange={() => setReason(value)}
            />
          ))}
        </fieldset>
        {reason === "other" && (
          <TextField
            label={t("orders.declineNote")}
            value={note}
            maxLength={ORDER_DECLINE_NOTE_MAX_LENGTH}
            onChange={setNote}
          />
        )}
        {!online && <Banner icon="wifiOff">{t("common.needNetwork")}</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  );
}
