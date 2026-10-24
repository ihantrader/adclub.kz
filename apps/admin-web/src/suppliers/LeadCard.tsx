import type {
  AdminSupplierLeadCard,
  AdminSupplierLeadResponse,
  SupplierLeadStatusValue,
} from "@adclub/contracts";
import {
  ActionBar,
  Banner,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  MenuButton,
  SkeletonList,
  StatusBadge,
  TextAreaField,
  useToast,
  type MenuAction,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { formatMoment } from "../format";
import { AppLink, Header } from "../layout/layout";
import { PhoneReveal } from "../people/PhoneReveal";
import { navigateTo, supplierLeadPath, supplierNewPath, supplierPath } from "../router";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import {
  LEADS_CRUMB,
  ReasonDialog,
  SaverError,
  SUPPLIERS_CRUMB,
  useSupplierSaver,
  WasNow,
} from "./shared";
import {
  consentVersionText,
  hiddenPhone,
  LEAD_SOURCE_TEXT,
  LEAD_STATUS_TEXT,
  LEAD_STATUSES,
  leadMoves,
  SUPPLIER_TYPE_TEXT,
} from "./supplier-words";
import "./suppliers.css";

const LANGUAGE_TEXT = { kk: "казахский", ru: "русский", en: "английский" } as const;

/**
 * The card of a connection request (A-SUP-01; TASK-036, TASK-080): the crumbs
 * of «Поставщики», the company as the title, its stage under it; the data
 * of the form (the phone partly hidden with the eye, SCREENS 7.0), the
 * requests of its БИН, the stage with the moves the server allows from it
 * (the domain's `supplierLeadTransition`; rejecting and returning — with a
 * reason, in «⋯» of the head), «Завести поставщика» once the contract is
 * signed, notes, the history from the journal.
 */
export function LeadCard({ leadId }: { leadId: string }) {
  const card = useLoad<AdminSupplierLeadResponse>(
    () => apiClient.getSupplierLead({ leadId }),
    `lead:${leadId}`,
  );
  const data = card.data && card.data.lead.lead.id === leadId ? card.data.lead : undefined;
  const [historyKey, setHistoryKey] = useState(0);
  const changed = (next: AdminSupplierLeadCard) => {
    card.replace({ lead: next });
    setHistoryKey((key) => key + 1);
  };
  const moves = useLeadMoves(data, changed);
  const lead = data?.lead;

  return (
    <>
      <Header
        crumbs={[SUPPLIERS_CRUMB, LEADS_CRUMB]}
        title={lead ? lead.companyName : "Заявка на подключение"}
        subtitle={
          lead && (
            <>
              <StatusBadge kind="supplierLead" status={lead.status}>
                {LEAD_STATUS_TEXT[lead.status]}
              </StatusBadge>
              <span>
                с {formatMoment(lead.statusChangedAt)} · {LEAD_SOURCE_TEXT[lead.source]}
              </span>
            </>
          )
        }
        actions={
          <>
            <IconButton icon="refresh" label="Обновить" size={20} onClick={card.reload} />
            {moves.menu.length > 0 && (
              <MenuButton label="Действия с заявкой" actions={moves.menu} />
            )}
          </>
        }
      />
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={data !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {data && (
          <div className="detail-stack">
            <LeadBanners card={data} />
            <LeadFacts card={data} />
            {data.lead.status !== "onboarded" && (
              <LeadStage card={data} moves={moves} onReload={card.reload} />
            )}
            <Notes card={data} onChanged={changed} />
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">История</h2>
              </div>
              <JournalHistory
                key={historyKey}
                filter={{ entityType: "supplier_lead", entityId: leadId }}
                loadKey={`lead-history:${leadId}:${historyKey}`}
                caption="История заявки"
                empty="Записей пока нет"
              />
            </section>
          </div>
        )}
      </LoadingContent>
      {data && (
        <ReasonDialog
          open={moves.asking !== null}
          title={moves.asking === "rejected" ? "Отказ по заявке" : "Вернуть заявку в работу"}
          confirm={moves.asking === "rejected" ? "Отказать" : "Вернуть в работу"}
          busy={moves.saver.saving}
          onClose={() => moves.setAsking(null)}
          onConfirm={(reason) => moves.asking && void moves.move(moves.asking, reason)}
          error={<SaverError saver={moves.saver} onRefresh={card.reload} />}
        >
          <WasNow
            was={LEAD_STATUS_TEXT[data.lead.status]}
            now={moves.asking ? LEAD_STATUS_TEXT[moves.asking] : ""}
          />
          <p className="ac-text-body-s">
            {moves.asking === "rejected"
              ? "Причину увидят администраторы в карточке и журнале. Заявку можно будет вернуть в работу."
              : "Заявка вернётся в работу; причина попадёт в журнал."}
          </p>
        </ReasonDialog>
      )}
    </>
  );
}

function LeadBanners({ card }: { card: AdminSupplierLeadCard }) {
  const { lead } = card;
  return (
    <>
      {lead.status === "rejected" && lead.rejectReason && (
        <Banner tone="warning">Отказ: {lead.rejectReason}</Banner>
      )}
      {lead.supplierId && (
        <Banner
          tone="neutral"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() => navigateTo(supplierPath(lead.supplierId!))}
            >
              Открыть карточку
            </Button>
          }
        >
          Поставщик заведён из этой заявки
        </Banner>
      )}
      {lead.existingSupplierId && !lead.supplierId && (
        <Banner
          tone="warning"
          action={
            <Button
              variant="text"
              size="s"
              onClick={() => navigateTo(supplierPath(lead.existingSupplierId!))}
            >
              Открыть
            </Button>
          }
        >
          Поставщик с этим БИН уже есть. Второго поставщика с тем же БИН сервер не заведёт.
        </Banner>
      )}
    </>
  );
}

function LeadFacts({ card }: { card: AdminSupplierLeadCard }) {
  const { lead, related } = card;
  return (
    <section className="card">
      <h2 className="card__title">Заявка</h2>
      <dl className="kv supplier-kv">
        <dt>Компания</dt>
        <dd>{lead.companyName}</dd>
        <dt>БИН</dt>
        <dd>{lead.bin}</dd>
        <dt>Город</dt>
        <dd>{lead.city.names.ru}</dd>
        <dt>Что предлагает</dt>
        <dd>{SUPPLIER_TYPE_TEXT[lead.type]}</dd>
        <dt>Контактное лицо</dt>
        <dd>{lead.contactName}</dd>
        <dt>Телефон</dt>
        <dd>
          <PhoneReveal phone={hiddenPhone(lead.phone)} subject="supplier_lead" id={lead.id} />
        </dd>
        <dt>Откуда</dt>
        <dd>
          {LEAD_SOURCE_TEXT[lead.source]}
          {lead.language ? ` · язык формы — ${LANGUAGE_TEXT[lead.language]}` : ""}
        </dd>
        <dt>Пришла</dt>
        <dd className="nowrap">{formatMoment(lead.createdAt)}</dd>
        {lead.consentAt && (
          <>
            <dt>Согласие на обработку данных</dt>
            <dd>
              Дано {formatMoment(lead.consentAt)}
              {lead.consentVersion ? ` · ${consentVersionText(lead.consentVersion)}` : ""}
            </dd>
          </>
        )}
      </dl>
      {related.length > 0 && (
        <div className="supplier-related">
          <h3 className="ac-text-body-strong">Другие заявки этого БИН</h3>
          <ul className="supplier-related__list">
            {related.map((other) => (
              <li key={other.id}>
                <AppLink href={supplierLeadPath(other.id)}>{other.companyName}</AppLink>
                <StatusBadge kind="supplierLead" status={other.status}>
                  {LEAD_STATUS_TEXT[other.status]}
                </StatusBadge>
                <span className="ac-muted ac-text-body-s nowrap">
                  {formatMoment(other.createdAt)} · {LEAD_SOURCE_TEXT[other.source]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The moves of the funnel the server allows from the request's status; a reason where it asks. */
function useLeadMoves(
  card: AdminSupplierLeadCard | undefined,
  onChanged: (card: AdminSupplierLeadCard) => void,
) {
  const toast = useToast();
  const online = useOnline();
  const saver = useSupplierSaver("supplier_lead");
  const [asking, setAsking] = useState<SupplierLeadStatusValue | null>(null);
  const lead = card?.lead;
  const moves = lead && lead.status !== "onboarded" ? leadMoves(lead.status) : [];

  const move = async (to: SupplierLeadStatusValue, reason?: string) => {
    if (!lead) return;
    let next: AdminSupplierLeadCard | null = null;
    const done = await saver.run(lead.id, async () => {
      const answer = await apiClient.setSupplierLeadStatus(
        { leadId: lead.id },
        {
          expectedVersion: saver.versionOf(lead.version),
          status: to,
          ...(reason ? { reason } : {}),
        },
      );
      next = answer.lead;
    });
    if (done && next) {
      setAsking(null);
      saver.reset();
      onChanged(next);
      toast.show(`Этап: ${LEAD_STATUS_TEXT[to]}`);
    }
  };

  // Rejecting and returning are rare and need a reason: «⋯» of the head (X11).
  const menu: MenuAction[] = moves
    .filter((entry) => entry.reasonRequired)
    .map((entry) => ({
      key: entry.to,
      label: entry.to === "rejected" ? "Отказ…" : `Вернуть: ${LEAD_STATUS_TEXT[entry.to]}…`,
      icon: entry.to === "rejected" ? ("circleX" as const) : ("arrowLeft" as const),
      destructive: entry.to === "rejected",
      disabled: !online || saver.saving,
      onSelect: () => {
        saver.reset();
        setAsking(entry.to);
      },
    }));
  return {
    working: moves.filter((entry) => !entry.reasonRequired).map((entry) => entry.to),
    menu,
    move,
    asking,
    setAsking,
    saver,
    online,
  };
}

/**
 * «Этап»: the stages of the funnel in their order, the current one marked;
 * the next stage is the main action (from «Договор подписан» —
 * «Завести поставщика»), the other allowed ones are secondary.
 */
function LeadStage({
  card,
  moves,
  onReload,
}: {
  card: AdminSupplierLeadCard;
  moves: ReturnType<typeof useLeadMoves>;
  onReload: () => void;
}) {
  const { lead } = card;
  const signed = lead.status === "contract_signed";
  const forward = moves.working.filter(
    (to) => LEAD_STATUSES.indexOf(to) > LEAD_STATUSES.indexOf(lead.status),
  );
  const next = signed ? null : (forward[0] ?? null);
  const rest = moves.working.filter((to) => to !== next);
  const busy = !moves.online || moves.saver.saving;
  return (
    <section className="card">
      <h2 className="card__title">Этап</h2>
      <ol className="lead-steps" aria-label="Этапы воронки">
        {LEAD_STATUSES.filter((step) => step !== "rejected").map((step) => {
          const index = LEAD_STATUSES.indexOf(step);
          const now = LEAD_STATUSES.indexOf(lead.status);
          const state =
            lead.status === "rejected"
              ? "lead-steps__step"
              : step === lead.status
                ? "lead-steps__step lead-steps__step--now"
                : index < now
                  ? "lead-steps__step lead-steps__step--done"
                  : "lead-steps__step";
          return (
            <li
              key={step}
              className={state}
              aria-current={step === lead.status ? "step" : undefined}
            >
              {LEAD_STATUS_TEXT[step]}
            </li>
          );
        })}
      </ol>
      {/* With the reason's dialog open, its error shows there. */}
      {moves.asking === null && <SaverError saver={moves.saver} onRefresh={onReload} />}
      <ActionBar
        label="Этап заявки"
        main={
          signed ? (
            <Button
              icon="plus"
              disabled={!moves.online}
              onClick={() => navigateTo(supplierNewPath(lead.id))}
            >
              Завести поставщика
            </Button>
          ) : next ? (
            <Button disabled={busy} onClick={() => void moves.move(next)}>
              {LEAD_STATUS_TEXT[next]}
            </Button>
          ) : undefined
        }
        others={rest.map((to) => (
          <Button key={to} variant="secondary" disabled={busy} onClick={() => void moves.move(to)}>
            {LEAD_STATUS_TEXT[to]}
          </Button>
        ))}
        note={signed ? undefined : "Завести поставщика можно с этапа «Договор подписан»"}
      />
    </section>
  );
}

function Notes({
  card,
  onChanged,
}: {
  card: AdminSupplierLeadCard;
  onChanged: (card: AdminSupplierLeadCard) => void;
}) {
  const online = useOnline();
  const saver = useSupplierSaver("supplier_lead");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    if (!text.trim()) {
      setProblem("Напишите заметку");
      return;
    }
    let next: AdminSupplierLeadCard | null = null;
    await saver.run(null, async () => {
      next = (await apiClient.addSupplierLeadNote({ leadId: card.lead.id }, { text: text.trim() }))
        .lead;
    });
    if (next) {
      setText("");
      onChanged(next);
    }
  };
  return (
    <section className="card">
      <h2 className="card__title">Заметки</h2>
      {card.notes.length === 0 ? (
        <EmptyState compact icon="clipboard" title="Заметок пока нет" />
      ) : (
        <ul className="supplier-notes">
          {card.notes.map((note) => (
            <li key={note.id}>
              <span className="ac-text-caption ac-muted nowrap">
                {formatMoment(note.createdAt)}
              </span>
              <p className="ac-text-body-s supplier-notes__text">{note.text}</p>
            </li>
          ))}
        </ul>
      )}
      <TextAreaField
        label="Новая заметка"
        value={text}
        rows={2}
        maxLength={2000}
        onChange={(value) => {
          setText(value);
          setProblem(null);
        }}
        error={problem ?? undefined}
      />
      <SaverError saver={saver} />
      <ActionBar
        label="Заметка"
        main={
          <Button variant="secondary" disabled={!online} loading={saver.saving} onClick={add}>
            Добавить заметку
          </Button>
        }
      />
    </section>
  );
}
