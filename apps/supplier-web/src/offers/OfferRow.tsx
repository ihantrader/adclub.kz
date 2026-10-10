import type { OfferAvailability, SupplierOffer } from "@adclub/contracts";
import { Badge, Button, Dialog, Icon, IconButton, useToast } from "@adclub/ui";
import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { apiClient } from "../api";
import { useOnline } from "@adclub/web-session";
import { useLanguage, useT } from "../i18n";
import { navigate, navigateTo, offerPath } from "../router";
import {
  activeOrdersWarningKey,
  formatAmount,
  hiddenReasons,
  nowValues,
  offerProblem,
  rowCommit,
  rowDraftOf,
  typeAmount,
  type RowDraft,
  type RowFields,
} from "./offer-rules";
import { servicePriceLine } from "./service-offer-rules";

export interface OfferRowProps {
  offer: SupplierOffer;
  /** The offer as the server answered it after a change made here. */
  onChanged: (offer: SupplierOffer) => void;
  /** Withdrawn or returned: it leaves this tab. */
  onMoved: (offer: SupplierOffer) => void;
}

interface RowProblem {
  field: "price" | "leadDays" | null;
  text: string;
}

/** The item's name in the language of the answer, or the Russian one. */
export function itemName(offer: Pick<SupplierOffer, "item">): string {
  return offer.item.name.text ?? "";
}

/** «Shell · 550046375» — the brand and the article, as far as they are known. */
export function itemLine(offer: Pick<SupplierOffer, "item">): string {
  return [offer.item.brand?.name, offer.item.article].filter(Boolean).join(" · ");
}

/**
 * The editing of a row of S-OFF-01: price, availability and term are saved
 * as soon as a field is left (with the version read), then «Сохранено ·
 * Отменить» — «Отменить» sends the previous values back by the same kind
 * of change, so a colleague's change in between is a conflict, not
 * something overwritten. A conflict reloads the offer and leaves what was
 * typed in the field, saying what the offer is now.
 */
function useRowEditor(offer: SupplierOffer, onChanged: (offer: SupplierOffer) => void) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const [base, setBase] = useState(offer);
  const [draft, setDraft] = useState<RowDraft>(() => rowDraftOf(offer));
  const [problem, setProblem] = useState<RowProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const [priceSaved, setPriceSaved] = useState(false);

  // A newer offer from outside (the list reloaded): untouched fields follow it.
  if (offer.version !== base.version) {
    setBase(offer);
    if (rowCommit(base, draft).kind === "none") setDraft(rowDraftOf(offer));
  }

  const take = (next: SupplierOffer, keepDraft = false) => {
    onChanged(next);
    setBase(next);
    if (!keepDraft) setDraft(rowDraftOf(next));
  };

  const reload = async (): Promise<SupplierOffer | null> => {
    try {
      const { offer: fresh } = await apiClient.getSupplierOffer({ offerId: offer.id });
      return fresh;
    } catch {
      return null;
    }
  };

  /** «Отменить»: the previous values, by the same change, against the version it produced. */
  const undo = async (saved: SupplierOffer, previous: RowFields) => {
    try {
      const { offer: reverted } = await apiClient.updateSupplierOffer(
        { offerId: saved.id },
        { expectedVersion: saved.version, ...previous },
      );
      take(reverted);
      setPriceSaved(false);
      setProblem(null);
      toast.show(t("offers.undone"));
    } catch (error) {
      const found = offerProblem(error);
      if (found.conflict) {
        const fresh = await reload();
        if (fresh) take(fresh);
        setProblem({ field: null, text: t("offers.undoConflict") });
      } else {
        setProblem({ field: null, text: t(found.key, found.params) });
      }
    }
  };

  const commit = async (next: RowDraft) => {
    const decision = rowCommit(offer, next);
    if (decision.kind === "none") {
      setProblem(null);
      return;
    }
    if (decision.kind === "invalid") {
      setProblem({ field: decision.field, text: t(decision.key) });
      return;
    }
    if (!online || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      const { offer: saved } = await apiClient.updateSupplierOffer(
        { offerId: offer.id },
        { expectedVersion: offer.version, ...decision.change },
      );
      take(saved);
      setPriceSaved(decision.change.price !== undefined);
      toast.show(t("common.saved"), {
        action: { label: t("offers.undo"), onAction: () => void undo(saved, decision.previous) },
      });
    } catch (error) {
      const found = offerProblem(error);
      if (found.conflict) {
        const fresh = await reload();
        if (fresh) {
          take(fresh, true);
          setProblem({ field: null, text: t("offers.conflictKept", { now: nowValues(fresh, t) }) });
        } else {
          setProblem({ field: null, text: t("offers.conflict") });
        }
      } else {
        const field =
          found.field === "price" ? "price" : found.field === "leadDays" ? "leadDays" : null;
        setProblem({ field, text: t(found.key, found.params) });
      }
    } finally {
      setSaving(false);
    }
  };

  return { draft, setDraft, problem, setProblem, saving, commit, online, priceSaved };
}

function blurOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter") event.currentTarget.blur();
}

/** The three fields of a row: price, availability, term. */
function RowFields({
  offer,
  editor,
  editable,
}: {
  offer: SupplierOffer;
  editor: ReturnType<typeof useRowEditor>;
  editable: boolean;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const name = itemName(offer);
  const leadInput = useRef<HTMLInputElement>(null);
  const { draft, setDraft, problem, commit, online, saving } = editor;
  const disabled = !editable || !online;
  const service = offer.item.type === "service";

  // A service (TASK-019): only its one price is edited here; prices by
  // model are a table — on the card.
  if (service && offer.pricing.mode === "by_model") {
    return (
      <p className="offer-fields offer-fields--service">
        <span className="num">{servicePriceLine(offer, lang, t)}</span>
        <TitleLink offer={offer}>{t("offers.byModelPrices")}</TitleLink>
      </p>
    );
  }

  const setAvailability = (availability: OfferAvailability) => {
    const next = { ...draft, availability };
    setDraft(next);
    if (availability === "on_order" && draft.leadDays.replace(/\D/g, "") === "0") {
      editor.setProblem({ field: "leadDays", text: t("offers.error.onOrderNeedsDays") });
      leadInput.current?.focus();
      return;
    }
    void commit(next);
  };

  return (
    <div className="offer-fields" aria-busy={saving || undefined}>
      <label
        className={problem?.field === "price" ? "inline-field inline-field--error" : "inline-field"}
      >
        <span className="ac-visually-hidden">{`${t("offers.price")}: ${name}`}</span>
        <input
          className="inline-field__input inline-field__input--price num"
          inputMode="numeric"
          autoComplete="off"
          value={draft.price}
          disabled={disabled}
          aria-invalid={problem?.field === "price" || undefined}
          onChange={(event) => setDraft({ ...draft, price: typeAmount(event.target.value) })}
          onBlur={() => void commit(draft)}
          onKeyDown={blurOnEnter}
        />
        <span className="inline-field__unit" aria-hidden="true">
          ₸
        </span>
      </label>
      {service ? (
        <span className="ac-text-caption ac-muted">{t("serviceForm.single")}</span>
      ) : (
        <GoodsTerms
          name={name}
          draft={draft}
          disabled={disabled}
          problem={problem}
          leadInput={leadInput}
          onAvailability={setAvailability}
          onDraft={setDraft}
          onCommit={commit}
        />
      )}
    </div>
  );
}

/** Availability and the term of a row on goods (a service has neither). */
function GoodsTerms({
  name,
  draft,
  disabled,
  problem,
  leadInput,
  onAvailability,
  onDraft,
  onCommit,
}: {
  name: string;
  draft: RowDraft;
  disabled: boolean;
  problem: RowProblem | null;
  leadInput: RefObject<HTMLInputElement | null>;
  onAvailability: (availability: OfferAvailability) => void;
  onDraft: (draft: RowDraft) => void;
  onCommit: (draft: RowDraft) => Promise<void>;
}) {
  const t = useT();
  const setDraft = onDraft;
  const commit = onCommit;
  const setAvailability = onAvailability;
  return (
    <>
      <label className="inline-field inline-field--select">
        <span className="ac-visually-hidden">{`${t("offers.availability")}: ${name}`}</span>
        <select
          className="inline-field__select"
          value={draft.availability}
          disabled={disabled}
          onChange={(event) => setAvailability(event.target.value as OfferAvailability)}
        >
          <option value="in_stock">{t("offers.inStock")}</option>
          <option value="on_order">{t("offers.onOrder")}</option>
        </select>
        <Icon name="chevronDown" size={16} />
      </label>
      <label
        className={
          problem?.field === "leadDays"
            ? "inline-field inline-field--days inline-field--error"
            : "inline-field inline-field--days"
        }
      >
        <span className="ac-visually-hidden">{`${t("offers.leadDays")}: ${name}`}</span>
        <input
          ref={leadInput}
          className="inline-field__input num"
          inputMode="numeric"
          autoComplete="off"
          value={draft.leadDays}
          disabled={disabled}
          aria-invalid={problem?.field === "leadDays" || undefined}
          onChange={(event) =>
            setDraft({ ...draft, leadDays: event.target.value.replace(/\D/g, "").slice(0, 3) })
          }
          onBlur={() => void commit(draft)}
          onKeyDown={blurOnEnter}
        />
        <span className="inline-field__unit" aria-hidden="true">
          {t("offers.days")}
        </span>
      </label>
    </>
  );
}

/** Pickup and delivery as two marks, with words for screen readers. */
export function Receiving({ offer }: { offer: Pick<SupplierOffer, "pickup" | "delivery"> }) {
  const t = useT();
  return (
    <span className="receiving">
      {offer.pickup && <Icon name="store" size={20} label={t("offers.pickup")} />}
      {offer.delivery && <Icon name="truck" size={20} label={t("offers.delivery")} />}
    </span>
  );
}

/** «Активные заявки: N», marked when there are any. */
export function ActiveOrders({ count }: { count: number }) {
  const t = useT();
  return (
    <span className={count > 0 ? "active-orders active-orders--some" : "active-orders"}>
      {t("offers.activeOrders", { n: count })}
    </span>
  );
}

/** «Не видно клиентам: …» with the way to the company card when the fix is there. */
export function HiddenNote({
  offer,
  withWithdrawn = true,
}: {
  offer: SupplierOffer;
  withWithdrawn?: boolean;
}) {
  const t = useT();
  const reasons = hiddenReasons(offer, { withWithdrawn });
  if (reasons.length === 0) return null;
  const toCompany = reasons.some((reason) => reason.toCompany);
  return (
    <p className="hidden-note">
      <Icon name="info" size={16} />
      <span>
        {t("offers.hiddenTitle")}: {reasons.map((reason) => t(reason.key)).join("; ")}
        {toCompany && (
          <>
            {" "}
            <a
              className="text-link"
              href="/company"
              onClick={(event) => {
                event.preventDefault();
                navigate("company");
              }}
            >
              {t("offers.openCompany")}
            </a>
          </>
        )}
      </span>
    </p>
  );
}

/**
 * «Снять с продажи»: with active orders — a warning that they still have to
 * be fulfilled (SCREENS S-OFF-01), and withdrawing is allowed all the same.
 */
function useStatusActions(offer: SupplierOffer, onMoved: (offer: SupplierOffer) => void) {
  const t = useT();
  const { lang } = useLanguage();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withdraw = async () => {
    setError(null);
    try {
      const { offer: withdrawn } = await apiClient.withdrawSupplierOffer(
        { offerId: offer.id },
        { expectedVersion: offer.version },
      );
      setAsking(false);
      onMoved(withdrawn);
      toast.show(t("offers.withdrawn"));
    } catch (thrown) {
      setAsking(false);
      setError(t(offerProblem(thrown).key, offerProblem(thrown).params));
    }
  };

  const giveBack = async () => {
    setError(null);
    try {
      const { offer: returned } = await apiClient.returnSupplierOffer(
        { offerId: offer.id },
        { expectedVersion: offer.version },
      );
      onMoved(returned);
      toast.show(t("offers.returned"));
      // The price was set before it was withdrawn: the card asks to check it.
      navigateTo(offerPath(returned.id), { state: { checkPrice: true } });
    } catch (thrown) {
      setError(t(offerProblem(thrown).key, offerProblem(thrown).params));
    }
  };

  const dialog = (
    <Dialog
      open={asking}
      onClose={() => setAsking(false)}
      title={t("offers.withdrawTitle")}
      actions={
        <>
          <Button variant="danger" onClick={withdraw}>
            {t("offers.withdraw")}
          </Button>
          <Button variant="secondary" onClick={() => setAsking(false)}>
            {t("common.cancel")}
          </Button>
        </>
      }
    >
      <p className="ac-text-body">
        {t(activeOrdersWarningKey(lang, offer.activeOrders), { n: offer.activeOrders })}
      </p>
    </Dialog>
  );

  return {
    askWithdraw: () => (offer.activeOrders > 0 ? setAsking(true) : void withdraw()),
    giveBack,
    error,
    dialog,
  };
}

function TitleLink({ offer, children }: { offer: SupplierOffer; children: ReactNode }) {
  return (
    <a
      className="offer-title"
      href={offerPath(offer.id)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigateTo(offerPath(offer.id));
      }}
    >
      {children}
    </a>
  );
}

function StatusButton({
  offer,
  actions,
  disabled,
  compact = false,
}: {
  offer: SupplierOffer;
  actions: ReturnType<typeof useStatusActions>;
  disabled: boolean;
  /** A line of the table: the icon alone, the words for screen readers and as a tooltip. */
  compact?: boolean;
}) {
  const t = useT();
  if (compact) {
    const withdrawn = offer.status === "withdrawn";
    return (
      <IconButton
        icon={withdrawn ? "refresh" : "archive"}
        label={`${t(withdrawn ? "offers.return" : "offers.withdraw")}: ${itemName(offer)}`}
        disabled={disabled}
        onClick={withdrawn ? actions.giveBack : actions.askWithdraw}
      />
    );
  }
  return offer.status === "withdrawn" ? (
    <Button
      variant="secondary"
      size="s"
      icon="refresh"
      disabled={disabled}
      onClick={actions.giveBack}
    >
      {t("offers.return")}
    </Button>
  ) : (
    <Button variant="text" size="s" disabled={disabled} onClick={actions.askWithdraw}>
      {t("offers.withdraw")}
    </Button>
  );
}

/** A row of S-OFF-01 on a phone: a card with the fields editable in place. */
export function OfferCardRow({ offer, onChanged, onMoved }: OfferRowProps) {
  const t = useT();
  const { lang } = useLanguage();
  const editor = useRowEditor(offer, onChanged);
  const actions = useStatusActions(offer, onMoved);
  const onSale = offer.status !== "withdrawn";
  const service = offer.item.type === "service";
  return (
    <article className="offer-card">
      <div className="offer-card__head">
        <TitleLink offer={offer}>{itemName(offer)}</TitleLink>
        {service && (
          <Badge tone="neutral" icon="settings">
            {t("offers.service")}
          </Badge>
        )}
        {!service && !offer.item.photo && (
          <Badge tone="neutral" icon="package">
            {t("offers.noPhoto")}
          </Badge>
        )}
      </div>
      <p className="ac-text-body-s ac-muted offer-card__line">
        {itemLine(offer) && <span className="num">{itemLine(offer)}</span>}
        <ActiveOrders count={offer.activeOrders} />
      </p>
      {onSale ? (
        <RowFields offer={offer} editor={editor} editable />
      ) : (
        <p className="ac-text-body num">
          {service
            ? servicePriceLine(offer, lang, t)
            : `${formatAmount(offer.price)} ₸ · ${t(
                offer.availability === "in_stock" ? "offers.inStock" : "offers.onOrder",
              )}`}
        </p>
      )}
      <div className="offer-card__meta">
        <Receiving offer={offer} />
        {(editor.priceSaved || editor.draft.price !== formatAmount(offer.price)) && onSale && (
          <span className="ac-text-caption ac-muted">{t("offers.newPriceHint")}</span>
        )}
      </div>
      {editor.problem && (
        <p className="ac-field__help ac-field__help--error" role="alert">
          <Icon name="alertTriangle" size={16} />
          <span>{editor.problem.text}</span>
        </p>
      )}
      {actions.error && (
        <p className="ac-field__help ac-field__help--error" role="alert">
          <Icon name="alertTriangle" size={16} />
          <span>{actions.error}</span>
        </p>
      )}
      <HiddenNote offer={offer} withWithdrawn={false} />
      <div className="offer-card__actions">
        <StatusButton offer={offer} actions={actions} disabled={!editor.online} />
      </div>
      {actions.dialog}
    </article>
  );
}

/** A row of S-OFF-01 from 1024 px: a line of the table, the same editing. */
export function OfferTableRow({ offer, onChanged, onMoved }: OfferRowProps) {
  const t = useT();
  const { lang } = useLanguage();
  const editor = useRowEditor(offer, onChanged);
  const actions = useStatusActions(offer, onMoved);
  const onSale = offer.status !== "withdrawn";
  const service = offer.item.type === "service";
  const problem = editor.problem?.text ?? actions.error;
  return (
    <tr>
      <td className="offers-table__item">
        <TitleLink offer={offer}>{itemName(offer)}</TitleLink>
        {service && (
          <>
            {" "}
            <Badge tone="neutral" icon="settings">
              {t("offers.service")}
            </Badge>
          </>
        )}
        {!service && !offer.item.photo && (
          <>
            {" "}
            <Badge tone="neutral" icon="package">
              {t("offers.noPhoto")}
            </Badge>
          </>
        )}
        {itemLine(offer) && <div className="ac-text-caption ac-muted num">{itemLine(offer)}</div>}
        {problem && (
          <p className="ac-field__help ac-field__help--error" role="alert">
            <Icon name="alertTriangle" size={16} />
            <span>{problem}</span>
          </p>
        )}
        {(editor.priceSaved || editor.draft.price !== formatAmount(offer.price)) && onSale && (
          <div className="ac-text-caption ac-muted">{t("offers.newPriceHint")}</div>
        )}
        <HiddenNote offer={offer} withWithdrawn={false} />
        {actions.dialog}
      </td>
      <td colSpan={onSale ? 3 : 1}>
        {onSale ? (
          <RowFields offer={offer} editor={editor} editable />
        ) : (
          <span className="num">
            {service ? servicePriceLine(offer, lang, t) : `${formatAmount(offer.price)} ₸`}
          </span>
        )}
      </td>
      {!onSale && (
        <>
          <td>
            {service
              ? "—"
              : t(offer.availability === "in_stock" ? "offers.inStock" : "offers.onOrder")}
          </td>
          <td className="num">{service ? "—" : offer.leadDays}</td>
        </>
      )}
      <td>
        <Receiving offer={offer} />
      </td>
      <td className={offer.activeOrders > 0 ? "num active-orders--some" : "num ac-muted"}>
        {offer.activeOrders}
      </td>
      <td>
        <StatusButton offer={offer} actions={actions} disabled={!editor.online} compact />
      </td>
    </tr>
  );
}
