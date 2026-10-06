import type {
  OfferAvailability,
  OfferItem,
  OfferReceipt,
  SupplierCard,
  SupplierOffer,
} from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DelayedSkeleton,
  Dialog,
  EmptyState,
  FadeSwap,
  Icon,
  IconButton,
  ScreenError,
  Segments,
  SkeletonList,
  TextField,
  toastObstacle,
  useLoadingGate,
  useToast,
} from "@adclub/ui";
import { isApiError } from "@adclub/api-client";
import { useEffect, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { useOnline } from "../connection";
import { useLanguage, useT } from "../i18n";
import {
  goBack,
  navigate,
  navigateTo,
  offerPath,
  replaceRouteState,
  useRouteId,
  useRouteState,
} from "../router";
import { ActiveOrders, HiddenNote, Receiving } from "./OfferRow";
import {
  activeOrdersWarningKey,
  categoryLine,
  changedValues,
  checkOfferForm,
  newOfferForm,
  nowValues,
  offerFormOf,
  offerProblem,
  receiptPreview,
  typeAmount,
  type OfferField,
  type OfferForm,
  type OfferProblem,
  type WarrantyKind,
} from "./offer-rules";

const PREVIEW_DELAY_MS = 300;

/** The price field: «Проверьте цену» puts the cursor there. */
const PRICE_FIELD = "offer-price";

function focusPrice(): void {
  document.getElementById(PRICE_FIELD)?.focus();
}

/** What a page of an offer was opened with (the history entry keeps it over a reload). */
interface OpenedWith {
  item?: OfferItem;
  checkPrice?: boolean;
  saved?: boolean;
}

/** S-OFF-03 for a new offer: the item comes from the search (S-OFF-02). */
export function NewOfferScreen({ company }: { company: SupplierCard }) {
  const opened = useRouteState() as OpenedWith | null;
  const item = opened?.item;
  useEffect(() => {
    // Opened without an item (a typed address): the search is where one is chosen.
    if (!item) navigate("offerSearch", { replace: true });
  }, [item]);
  if (!item) return null;
  return <OfferEditor item={item} offer={null} company={company} />;
}

type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "failed"; error: unknown }
  | { status: "ready"; offer: SupplierOffer };

/** The card of an offer (TASK-032 requirement 5): `/offers/<id>`, the same form, editable. */
export function OfferCardScreen({ company }: { company: SupplierCard }) {
  const id = useRouteId();
  // Another offer is another card: nothing of the previous one stays.
  return id ? <OfferCard key={id} id={id} company={company} /> : null;
}

function OfferCard({ id, company }: { id: string; company: SupplierCard }) {
  const t = useT();
  const gate = useLoadingGate();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const { begin, settle } = gate;

  // The answer (or the error) comes through the loading rule (D-069): a quick
  // one at once, a slow one after its skeleton has been seen. «Повторить»
  // keeps the error on screen until the new answer, its button says it waits.
  const fetchOffer = async () => {
    const ticket = begin();
    try {
      const { offer } = await apiClient.getSupplierOffer({ offerId: id });
      settle(ticket, () => setLoaded({ status: "ready", offer }));
    } catch (error) {
      settle(ticket, () =>
        setLoaded(
          isApiError(error) && error.code === "NOT_FOUND"
            ? { status: "missing" }
            : { status: "failed", error },
        ),
      );
    }
  };

  useEffect(() => {
    // Loading on mount, as «Сотрудники» does: no state is set before the
    // answer. Keyed by the id, so once per card.
    void fetchOffer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let body: ReactNode;
  switch (loaded.status) {
    case "loading":
      body = (
        <>
          <BackHead title={t("offerForm.title")} />
          <DelayedSkeleton indicator={gate.indicator}>
            <SkeletonList rows={2} label={t("common.loading")} />
          </DelayedSkeleton>
        </>
      );
      break;
    case "missing":
      // Another company's offer, or one of the company switched away from.
      body = (
        <>
          <BackHead title={t("offerForm.title")} />
          <EmptyState
            icon="search"
            title={t("offers.error.notFound")}
            action={
              <Button variant="secondary" onClick={() => navigate("offers", { replace: true })}>
                {t("offerForm.toList")}
              </Button>
            }
          />
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <BackHead title={t("offerForm.title")} />
          <ScreenError
            title={t("common.errorTitle")}
            text={t("common.errorText")}
            retry={{ label: t("common.retry"), onRetry: fetchOffer }}
          />
        </>
      );
      break;
    default:
      body = (
        <OfferEditor
          key={loaded.offer.id}
          item={loaded.offer.item}
          offer={loaded.offer}
          company={company}
          onOffer={(offer) => setLoaded({ status: "ready", offer })}
        />
      );
  }
  // What the card shows fades in when it changes from loading to the offer,
  // the same 150 ms as the page around it.
  return (
    <FadeSwap className="page-part" fadeKey={loaded.status}>
      {body}
    </FadeSwap>
  );
}

function BackHead({ title }: { title: string }) {
  const t = useT();
  return (
    <div className="page__head page__head--back">
      <IconButton icon="arrowLeft" label={t("common.back")} onClick={() => goBack("offers")} />
      <h1 className="ac-text-title page__title">{title}</h1>
    </div>
  );
}

/** The item of an offer — read only (S-OFF-03). */
function ItemBlock({ item }: { item: OfferItem }) {
  const line = [item.brand?.name, item.article].filter(Boolean).join(" · ");
  return (
    <section className="card item-block">
      <span className="item-block__thumb" aria-hidden="true">
        {item.photo ? <img src={item.photo.thumbUrl} alt="" /> : <Icon name="package" size={24} />}
      </span>
      <div className="item-block__text">
        <p className="ac-text-body-strong item-block__name">{item.name.text}</p>
        {line && <p className="ac-text-body-s num">{line}</p>}
        <p className="ac-text-body-s ac-muted">{categoryLine(item)}</p>
      </div>
    </section>
  );
}

function FieldError({ problem, field }: { problem: OfferProblem | null; field: OfferField }) {
  const t = useT();
  if (problem?.field !== field) return null;
  return (
    <p className="ac-field__help ac-field__help--error" role="alert">
      <Icon name="alertTriangle" size={16} />
      <span>
        {t(problem.key, problem.params)} <ProblemLink problem={problem} />
      </span>
    </p>
  );
}

function ProblemLink({ problem }: { problem: OfferProblem }) {
  const t = useT();
  if (!problem.link) return null;
  const link = problem.link;
  return (
    <a
      className="text-link"
      href={link.to === "company" ? "/company" : offerPath(link.offerId)}
      onClick={(event) => {
        event.preventDefault();
        if (link.to === "company") navigate("company");
        else navigateTo(offerPath(link.offerId));
      }}
    >
      {t(link.to === "company" ? "offers.openCompany" : "offers.error.openExisting")}
    </a>
  );
}

/**
 * «Клиент увидит: Самовывоз — завтра, 14 марта» (S-OFF-03): the server's
 * receipt date for the term in the form, asked again when the term changes.
 * No hours at the point — the D-060 warning with the way to «Компания».
 */
function ReceiptPreview({ form, initial }: { form: OfferForm; initial: OfferReceipt | null }) {
  const t = useT();
  const { lang } = useLanguage();
  const days = /^\d{1,3}$/.test(form.leadDays) ? Number(form.leadDays) : null;
  const [receipt, setReceipt] = useState<OfferReceipt | null>(
    initial && initial.leadDays === days ? initial : null,
  );
  const [failed, setFailed] = useState(false);
  const gate = useLoadingGate();
  const { begin, settle, cancel } = gate;

  useEffect(() => {
    if (days === null) {
      cancel();
      return;
    }
    const controller = new AbortController();
    // The date of the previous term stays until the new one is there (D-069);
    // «Загрузка…» only where there is nothing yet and the wait is not short.
    const ticket = begin();
    const timer = setTimeout(() => {
      apiClient
        .previewOfferReceipt({ query: { leadDays: days }, signal: controller.signal })
        .then(({ receipt: next }) =>
          settle(ticket, () => {
            setReceipt(next);
            setFailed(false);
          }),
        )
        .catch(() => {
          if (!controller.signal.aborted) settle(ticket, () => setFailed(true));
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [days, begin, settle, cancel]);

  const stale = receipt !== null && receipt.leadDays !== days;
  let body: ReactNode;
  if (days === null || failed) {
    body = <p className="ac-text-body-s ac-muted">{t("offerForm.previewUnknown")}</p>;
  } else if (receipt === null) {
    body = (
      <p className="ac-text-body-s ac-muted">{gate.indicator ? `${t("common.loading")}…` : " "}</p>
    );
  } else if (receipt.unavailable) {
    body = (
      <p className="ac-text-body-s preview__warning">
        {t(
          receipt.unavailable === "hours_not_set"
            ? "offerForm.previewNoHours"
            : "offerForm.previewNoWorkingDay",
        )}{" "}
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
      </p>
    );
  } else {
    const lines = receiptPreview(receipt, form, lang, t) ?? [];
    body = lines.map((line) => (
      <p key={line} className="ac-text-body">
        {line}
      </p>
    ));
  }

  const price = form.price ? `${form.price} ₸` : null;
  return (
    <section className="card preview" aria-live="polite">
      <p className="ac-text-caption ac-muted">{t("offerForm.preview")}</p>
      {price && <p className="ac-text-heading num">{price}</p>}
      <p className="ac-text-body-s">
        {t(form.availability === "in_stock" ? "offers.inStock" : "offers.onOrder")}
      </p>
      <div
        className={
          stale && gate.indicator ? "preview__receipt preview__receipt--dim" : "preview__receipt"
        }
        aria-busy={stale || undefined}
      >
        {body}
      </div>
    </section>
  );
}

/**
 * The form of S-OFF-03 for a new offer and for the card of an existing one.
 * Every rule of an offer is checked by the server (the bounds of the price
 * and the term are settings; contacts in the warranty; pickup needs the
 * point's address); its refusal is shown at the field it is about.
 */
function OfferEditor({
  item,
  offer,
  company,
  onOffer,
}: {
  item: OfferItem;
  offer: SupplierOffer | null;
  company: SupplierCard;
  onOffer?: (offer: SupplierOffer) => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const toast = useToast();
  const online = useOnline();
  const opened = useRouteState() as OpenedWith | null;
  const [form, setForm] = useState<OfferForm>(() =>
    offer ? offerFormOf(offer) : newOfferForm(company.deliveryByDefault),
  );
  const [problem, setProblem] = useState<OfferProblem | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const checkPrice = offer !== null && opened?.checkPrice === true;

  // «Вернуть в продажу» opened the card to check the price: put the cursor there.
  useEffect(() => {
    if (checkPrice) focusPrice();
  }, [checkPrice]);

  const set = (change: Partial<OfferForm>) => {
    setForm((current) => ({ ...current, ...change }));
    setProblem(null);
  };

  const checked = checkOfferForm(form);
  const changed = offer && checked.ok ? changedValues(offer, checked.values) : null;
  const dirty = offer === null || changed === null || Object.keys(changed).length > 0;

  const save = async () => {
    setConflict(null);
    if (!checked.ok) {
      setProblem({ field: checked.field, key: checked.key });
      return;
    }
    setSaving(true);
    try {
      if (offer === null) {
        const { offer: created } = await apiClient.createSupplierOffer({
          itemId: item.id,
          ...checked.values,
        });
        toast.show(t("common.saved"));
        // The card of the new offer takes the place of the form in the history.
        navigateTo(offerPath(created.id), { replace: true, state: { saved: true } });
        return;
      }
      if (!changed || Object.keys(changed).length === 0) return;
      const { offer: saved } = await apiClient.updateSupplierOffer(
        { offerId: offer.id },
        { expectedVersion: offer.version, ...changed },
      );
      onOffer?.(saved);
      setForm(offerFormOf(saved));
      if (checkPrice) replaceRouteState({});
      toast.show(t("common.saved"));
    } catch (error) {
      const found = offerProblem(error);
      if (found.conflict && offer) {
        // A colleague changed it: the newest offer, and what was typed stays in the form.
        try {
          const { offer: fresh } = await apiClient.getSupplierOffer({ offerId: offer.id });
          onOffer?.(fresh);
          setConflict(t("offerForm.conflict", { now: nowValues(fresh, t) }));
        } catch {
          setConflict(t("offers.conflict"));
        }
      } else {
        setProblem(found);
      }
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (to: "withdraw" | "return") => {
    if (!offer) return;
    setAsking(false);
    try {
      const answer =
        to === "withdraw"
          ? await apiClient.withdrawSupplierOffer(
              { offerId: offer.id },
              { expectedVersion: offer.version },
            )
          : await apiClient.returnSupplierOffer(
              { offerId: offer.id },
              { expectedVersion: offer.version },
            );
      onOffer?.(answer.offer);
      toast.show(t(to === "withdraw" ? "offers.withdrawn" : "offers.returned"));
      if (to === "return") {
        replaceRouteState({ checkPrice: true });
        focusPrice();
      }
    } catch (error) {
      setProblem(offerProblem(error));
    }
  };

  const field = (name: OfferField) =>
    problem?.field === name ? <FieldError problem={problem} field={name} /> : null;
  const fieldError = (name: OfferField) =>
    problem?.field === name ? t(problem.key, problem.params) : undefined;
  const withdrawn = offer?.status === "withdrawn";

  return (
    <>
      <BackHead title={offer ? t("offerForm.title") : t("offerForm.newTitle")} />

      {checkPrice && !withdrawn && <Banner tone="warning">{t("offers.checkPrice")}</Banner>}
      {conflict && <Banner tone="warning">{conflict}</Banner>}
      {problem && problem.field === null && (
        <Banner tone={problem.conflict ? "warning" : "danger"}>
          {t(problem.key, problem.params)} <ProblemLink problem={problem} />
        </Banner>
      )}

      <ItemBlock item={item} />

      {offer && (
        <section className="card offer-state">
          {withdrawn ? (
            <Badge tone="neutral" icon="archive">
              {t("offers.hidden.withdrawn")}
            </Badge>
          ) : offer.showcase.visible ? (
            <Badge tone="success" icon="circleCheck">
              {t("offerForm.visible")}
            </Badge>
          ) : null}
          <HiddenNote offer={offer} withWithdrawn={false} />
          <p className="ac-text-body-s">
            <ActiveOrders count={offer.activeOrders} />
          </p>
          <div className="actions-row">
            {withdrawn ? (
              <Button
                variant="secondary"
                icon="refresh"
                disabled={!online}
                onClick={() => changeStatus("return")}
              >
                {t("offers.return")}
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={!online}
                onClick={() =>
                  offer.activeOrders > 0 ? setAsking(true) : changeStatus("withdraw")
                }
              >
                {t("offers.withdraw")}
              </Button>
            )}
          </div>
        </section>
      )}

      <form
        className="card stack-m offer-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextField
          id={PRICE_FIELD}
          label={t("offers.price")}
          value={form.price}
          onChange={(value) => set({ price: typeAmount(value) })}
          inputMode="numeric"
          autoComplete="off"
          hint={offer ? t("offers.newPriceHint") : t("offerForm.priceHint")}
          error={fieldError("price")}
          trailing={<span className="ac-muted">₸</span>}
          className="field-narrow"
        />

        <div className="field-block">
          <span className="field-block__label">{t("offers.availability")}</span>
          <Segments<OfferAvailability>
            label={t("offers.availability")}
            value={form.availability}
            onChange={(availability) => set({ availability })}
            options={[
              { value: "in_stock", label: t("offers.inStock") },
              { value: "on_order", label: t("offers.onOrder") },
            ]}
          />
        </div>

        <TextField
          label={t("offerForm.leadDays")}
          value={form.leadDays}
          onChange={(value) => set({ leadDays: value.replace(/\D/g, "").slice(0, 3) })}
          inputMode="numeric"
          autoComplete="off"
          hint={t(
            form.availability === "on_order"
              ? "offerForm.leadDaysOnOrder"
              : "offerForm.leadDaysInStock",
          )}
          error={fieldError("leadDays")}
          className="field-narrow"
        />

        <fieldset className="field-block">
          <legend className="field-block__label">{t("offers.receiving")}</legend>
          <Checkbox
            label={t("offers.pickup")}
            checked={form.pickup}
            onChange={(pickup) => set({ pickup })}
          />
          <Checkbox
            label={t("offers.delivery")}
            checked={form.delivery}
            onChange={(delivery) => set({ delivery })}
          />
          {field("pickup")}
          <p className="ac-text-body-s ac-muted">{t("offerForm.pickupHint")}</p>
        </fieldset>

        <div className="field-block">
          <span className="field-block__label">{t("offerForm.warranty")}</span>
          <Segments<WarrantyKind>
            label={t("offerForm.warranty")}
            value={form.warranty}
            onChange={(warranty) => set({ warranty })}
            options={[
              { value: "none", label: t("offerForm.warrantyNone") },
              { value: "months", label: t("offerForm.warrantyMonths") },
              { value: "text", label: t("offerForm.warrantyText") },
            ]}
          />
          {form.warranty === "months" && (
            <TextField
              label={t("offerForm.warrantyMonthsLabel")}
              value={form.warrantyMonths}
              onChange={(value) => set({ warrantyMonths: value.replace(/\D/g, "").slice(0, 3) })}
              inputMode="numeric"
              autoComplete="off"
              error={fieldError("warrantyMonths")}
              className="field-narrow"
            />
          )}
          {form.warranty === "text" && (
            <TextField
              label={t("offerForm.warrantyTextLabel")}
              value={form.warrantyText}
              onChange={(warrantyText) => set({ warrantyText })}
              maxLength={100}
              hint={t("offerForm.warrantyTextHint")}
              error={fieldError("warrantyText")}
            />
          )}
        </div>

        <div className="field-block">
          <span className="field-block__label">{t("offerForm.own")}</span>
          <TextField
            label={t("offerForm.supplierSku")}
            value={form.supplierSku}
            onChange={(supplierSku) => set({ supplierSku })}
            maxLength={64}
            autoComplete="off"
            error={fieldError("supplierSku")}
          />
          <TextField
            label={t("offerForm.supplierName")}
            value={form.supplierName}
            onChange={(supplierName) => set({ supplierName })}
            maxLength={200}
            autoComplete="off"
            hint={t("offerForm.ownHint")}
            error={fieldError("supplierName")}
          />
        </div>

        <ReceiptPreview form={form} initial={offer?.receipt ?? null} />
        {offer && <Receiving offer={offer} />}

        <div className="save-bar" {...toastObstacle}>
          <Button type="submit" size="l" loading={saving} disabled={!online || !dirty}>
            {offer ? t("common.save") : t("offerForm.create")}
          </Button>
          {!online && <span className="ac-text-caption ac-muted">{t("common.needNetwork")}</span>}
        </div>
      </form>

      {offer && (
        <WithdrawDialog
          open={asking}
          count={offer.activeOrders}
          lang={lang}
          onClose={() => setAsking(false)}
          onWithdraw={() => changeStatus("withdraw")}
        />
      )}
    </>
  );
}

function WithdrawDialog({
  open,
  count,
  lang,
  onClose,
  onWithdraw,
}: {
  open: boolean;
  count: number;
  lang: ReturnType<typeof useLanguage>["lang"];
  onClose: () => void;
  onWithdraw: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("offers.withdrawTitle")}
      actions={
        <>
          <Button variant="danger" onClick={onWithdraw}>
            {t("offers.withdraw")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </>
      }
    >
      <p className="ac-text-body">{t(activeOrdersWarningKey(lang, count), { n: count })}</p>
    </Dialog>
  );
}
