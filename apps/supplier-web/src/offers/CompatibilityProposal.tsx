import type { OfferItem } from "@adclub/contracts";
import { ActionBar, Banner, Button, SearchSelect, TextField } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useRef, useState } from "react";
import { apiClient } from "../api";
import { useT } from "../i18n";
import { navigate } from "../router";
import {
  chooseLevel,
  COMPATIBILITY_EVIDENCE_MAX_LENGTH,
  emptyProposalForm,
  proposalBody,
  proposalErrors,
  proposalRefusal,
  type ProposalErrors,
  type ProposalForm,
} from "./compatibility-proposal-rules";
import {
  generationNamed,
  loadEngines,
  loadGenerations,
  loadMakes,
  loadModels,
  searchNamed,
} from "./vehicle-choices";

/**
 * «Предложить данные о совместимости» of the offer card (S-OFF-03) and the
 * form behind it — S-OFF-07 (TASK-077): a car from the vehicle catalog by
 * the same choice with search as the prices by model, and the source. It
 * changes nothing for clients until an administrator approves it; the
 * result is in «Модерация → Совместимость».
 */
export function CompatibilityProposal({ item }: { item: OfferItem }) {
  const t = useT();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProposalForm>(emptyProposalForm);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<ProposalErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const inFlight = useRef(false);

  const errors: ProposalErrors = touched
    ? { ...proposalErrors(form, t), ...serverErrors }
    : serverErrors;
  const texts = {
    failed: t("searchSelect.failed"),
    nothing: t("searchSelect.nothing"),
    searching: t("searchSelect.searching"),
  };
  const now = t("compat.yearNow");

  const update = (next: ProposalForm) => {
    setForm(next);
    setServerErrors({});
    setRefusal(null);
  };

  async function send() {
    setTouched(true);
    const body = proposalBody(form);
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(null);
    try {
      await apiClient.createCompatibilityProposal({ itemId: item.id }, body);
      setSent(true);
      setForm(emptyProposalForm);
      setTouched(false);
    } catch (error) {
      const refused = proposalRefusal(error, t);
      setServerErrors(refused.fields);
      setRefusal(refused.text);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  if (!open) {
    return (
      <section className="card compat-proposal">
        <div className="stack-s">
          <h2 className="ac-text-heading">{t("compat.title")}</h2>
          <p className="ac-text-body-s ac-muted">{t("compat.lead")}</p>
        </div>
        <ActionBar
          compact
          others={[
            <Button
              key="open"
              variant="secondary"
              icon="car"
              onClick={() => {
                setOpen(true);
                setSent(false);
              }}
            >
              {t("compat.open")}
            </Button>,
          ]}
        />
      </section>
    );
  }

  return (
    <section className="card compat-proposal">
      <h2 className="ac-text-heading">{t("compat.title")}</h2>
      {sent ? (
        <>
          <Banner icon="circleCheck">{t("compat.sent")}</Banner>
          <ActionBar
            compact
            others={[
              <Button key="moderation" variant="secondary" onClick={() => navigate("moderation")}>
                {t("result.toModeration")}
              </Button>,
              <Button key="another" variant="secondary" onClick={() => setSent(false)}>
                {t("compat.another")}
              </Button>,
            ]}
          />
        </>
      ) : (
        <form
          className="form-grid"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <p className="ac-text-body-s ac-muted form-grid__wide">{t("compat.formLead")}</p>
          <SearchSelect
            label={t("compat.make")}
            value={form.make}
            onChange={(make) => update(chooseLevel(form, "make", make))}
            search={async (query) => searchNamed(await loadMakes(), query)}
            error={errors.make}
            texts={texts}
            name="conditions.makeId"
          />
          <SearchSelect
            label={t("compat.model")}
            value={form.model}
            onChange={(model) => update(chooseLevel(form, "model", model))}
            search={async (query) =>
              form.make ? searchNamed(await loadModels(form.make.id), query) : []
            }
            sourceKey={form.make?.id ?? ""}
            disabled={form.make === null}
            placeholder={t("compat.any")}
            error={errors.model}
            texts={texts}
            name="conditions.modelId"
          />
          <SearchSelect
            label={t("compat.generation")}
            value={form.generation}
            onChange={(generation) => update(chooseLevel(form, "generation", generation))}
            search={async (query) =>
              form.model
                ? searchNamed(
                    (await loadGenerations(form.model.id)).map((generation) =>
                      generationNamed(generation, now),
                    ),
                    query,
                  )
                : []
            }
            sourceKey={form.model?.id ?? ""}
            disabled={form.model === null}
            placeholder={t("compat.any")}
            error={errors.generation}
            texts={texts}
            name="conditions.generationId"
          />
          <SearchSelect
            label={t("compat.engine")}
            value={form.engine}
            onChange={(engine) => update(chooseLevel(form, "engine", engine))}
            search={async (query) =>
              form.generation ? searchNamed(await loadEngines(form.generation.id), query) : []
            }
            sourceKey={form.generation?.id ?? ""}
            disabled={form.generation === null}
            placeholder={t("compat.any")}
            error={errors.engine}
            texts={texts}
            name="conditions.engineId"
          />
          <div className="compat-years">
            <TextField
              label={t("compat.yearFrom")}
              value={form.yearFrom}
              inputMode="numeric"
              maxLength={4}
              placeholder={t("compat.any")}
              onChange={(value) => update({ ...form, yearFrom: value.replace(/\D/g, "") })}
              error={errors.yearFrom}
            />
            <TextField
              label={t("compat.yearTo")}
              value={form.yearTo}
              inputMode="numeric"
              maxLength={4}
              placeholder={t("compat.any")}
              onChange={(value) => update({ ...form, yearTo: value.replace(/\D/g, "") })}
              error={errors.yearTo}
            />
          </div>
          <TextField
            className="form-grid__wide"
            label={t("compat.evidence")}
            value={form.evidence}
            maxLength={COMPATIBILITY_EVIDENCE_MAX_LENGTH}
            hint={errors.evidence ? undefined : t("compat.evidenceHint")}
            onChange={(evidence) => update({ ...form, evidence })}
            error={errors.evidence}
          />
          {refusal && (
            <div className="form-grid__wide">
              <Banner tone="danger" icon="alertTriangle">
                {refusal}
              </Banner>
            </div>
          )}
          {/* Secondary: the page's main button is the offer's «Сохранить» (C15). */}
          <ActionBar
            compact
            className="form-grid__wide"
            others={[
              <Button
                key="send"
                type="submit"
                variant="secondary"
                loading={sending}
                disabled={sending || !online}
              >
                {t("compat.send")}
              </Button>,
              <Button key="cancel" variant="secondary" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>,
            ]}
          />
        </form>
      )}
    </section>
  );
}
