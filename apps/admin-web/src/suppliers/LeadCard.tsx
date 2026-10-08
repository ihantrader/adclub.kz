import type {
  AdminSupplierLeadCard,
  AdminSupplierLeadResponse,
  SupplierLeadStatusValue,
} from "@adclub/contracts";
import { Banner, Button, IconButton, LoadingContent, SkeletonList, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { goBack, navigateTo, supplierLeadPath, supplierNewPath, supplierPath } from "../router";
import { useLoad } from "../use-load";
import { FormError, LoadError } from "../vehicles/shared";
import { ReasonDialog, SuppliersTabs, useSupplierSaver, WasNow } from "./shared";
import {
  hiddenPhone,
  LEAD_SOURCE_TEXT,
  LEAD_STATUS_TEXT,
  leadMoves,
  SUPPLIER_TYPE_TEXT,
} from "./supplier-words";

const LANGUAGE_TEXT = { kk: "казахский", ru: "русский", en: "английский" } as const;

/**
 * The card of a connection request (A-SUP-01; TASK-036): the data of the
 * form (the phone partly hidden, SCREENS 7.0), the requests of its БИН,
 * notes, the moves the server allows from its status (the domain's
 * `supplierLeadTransition`; rejecting and returning — with a reason), «Завести
 * поставщика» once the contract is signed, the history from the journal.
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

  return (
    <>
      <div className="page__head page__head--back">
        <IconButton
          icon="arrowLeft"
          label="Назад к заявкам на подключение"
          onClick={() => goBack("supplierLeads")}
        />
        <div className="cell-stack">
          <h1 className="ac-text-title-l page__title long-text">
            {data ? data.lead.companyName : "Заявка на подключение"}
          </h1>
          {data && (
            <span className="ac-text-body-s ac-muted">
              Этап: {LEAD_STATUS_TEXT[data.lead.status]} · с{" "}
              {formatMoment(data.lead.statusChangedAt)}
            </span>
          )}
        </div>
        <Button variant="secondary" size="s" icon="refresh" onClick={card.reload}>
          Обновить
        </Button>
      </div>
      <SuppliersTabs active={null} />
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={data !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {data && (
          <div className="detail-stack">
            <LeadFacts card={data} />
            <LeadMoves card={data} onChanged={changed} onReload={card.reload} />
            <Notes card={data} onChanged={changed} />
            <section className="card-section">
              <h2 className="ac-text-heading">История</h2>
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
    </>
  );
}

function LeadFacts({ card }: { card: AdminSupplierLeadCard }) {
  const { lead, related } = card;
  return (
    <section className="card-section">
      {lead.status === "rejected" && lead.rejectReason && (
        <Banner tone="warning">Отказ: {lead.rejectReason}</Banner>
      )}
      {lead.supplierId && (
        <Banner tone="neutral">
          Поставщик заведён из этой заявки ·{" "}
          <AppLink href={supplierPath(lead.supplierId)}>Открыть карточку</AppLink>
        </Banner>
      )}
      {lead.existingSupplierId && !lead.supplierId && (
        <Banner tone="warning">
          Поставщик с этим БИН уже есть ·{" "}
          <AppLink href={supplierPath(lead.existingSupplierId)}>Открыть</AppLink>. Второго
          поставщика с тем же БИН сервер не заведёт.
        </Banner>
      )}
      <dl className="facts">
        <div>
          <dt>Компания</dt>
          <dd className="long-text">{lead.companyName}</dd>
        </div>
        <div>
          <dt>БИН</dt>
          <dd className="mono">{lead.bin}</dd>
        </div>
        <div>
          <dt>Город</dt>
          <dd>{lead.city.names.ru}</dd>
        </div>
        <div>
          <dt>Что предлагает</dt>
          <dd>{SUPPLIER_TYPE_TEXT[lead.type]}</dd>
        </div>
        <div>
          <dt>Контактное лицо</dt>
          <dd className="long-text">{lead.contactName}</dd>
        </div>
        <div>
          <dt>Телефон</dt>
          <dd className="num">{hiddenPhone(lead.phone)}</dd>
        </div>
        <div>
          <dt>Откуда</dt>
          <dd>
            {LEAD_SOURCE_TEXT[lead.source]}
            {lead.language ? `, язык формы — ${LANGUAGE_TEXT[lead.language]}` : ""}
          </dd>
        </div>
        <div>
          <dt>Пришла</dt>
          <dd className="num">{formatMoment(lead.createdAt)}</dd>
        </div>
        {lead.consentAt && (
          <div>
            <dt>Согласие на обработку данных</dt>
            <dd className="num">
              {formatMoment(lead.consentAt)}
              {lead.consentVersion ? `, текст ${lead.consentVersion}` : ""}
            </dd>
          </div>
        )}
      </dl>
      {related.length > 0 && (
        <div className="cell-stack">
          <span className="ac-text-body-strong">Другие заявки этого БИН</span>
          <ul className="plain-list">
            {related.map((other) => (
              <li key={other.id} className="ac-text-body-s">
                <AppLink href={supplierLeadPath(other.id)}>{other.companyName}</AppLink> ·{" "}
                {LEAD_STATUS_TEXT[other.status]} · {formatMoment(other.createdAt)} ·{" "}
                {LEAD_SOURCE_TEXT[other.source]}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The moves of the funnel the server allows from the request's status; a reason where it asks. */
function LeadMoves({
  card,
  onChanged,
  onReload,
}: {
  card: AdminSupplierLeadCard;
  onChanged: (card: AdminSupplierLeadCard) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const saver = useSupplierSaver("supplier_lead");
  const [asking, setAsking] = useState<SupplierLeadStatusValue | null>(null);
  const { lead } = card;
  const moves = leadMoves(lead.status);

  const move = async (to: SupplierLeadStatusValue, reason?: string) => {
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

  if (lead.status === "onboarded") return null;
  const working = moves.filter((entry) => !entry.reasonRequired);
  const withReason = moves.filter((entry) => entry.reasonRequired);
  return (
    <section className="card-section">
      <h2 className="ac-text-heading">Этап</h2>
      <div className="button-row">
        {lead.status === "contract_signed" && (
          <Button
            icon="plus"
            disabled={!online}
            onClick={() => navigateTo(supplierNewPath(lead.id))}
          >
            Завести поставщика
          </Button>
        )}
        {working.map((entry) => (
          <Button
            key={entry.to}
            variant="secondary"
            disabled={!online || saver.saving}
            onClick={() => void move(entry.to)}
          >
            {LEAD_STATUS_TEXT[entry.to]}
          </Button>
        ))}
        {withReason.map((entry) => (
          <Button
            key={entry.to}
            variant="secondary"
            disabled={!online || saver.saving}
            onClick={() => {
              saver.reset();
              setAsking(entry.to);
            }}
          >
            {entry.to === "rejected" ? "Отказ…" : `Вернуть: ${LEAD_STATUS_TEXT[entry.to]}…`}
          </Button>
        ))}
      </div>
      {lead.status !== "contract_signed" && (
        <p className="ac-text-caption ac-muted">
          Завести поставщика можно с этапа «Договор подписан».
        </p>
      )}
      {asking === null && <FormError saver={saver} onRefresh={onReload} />}
      <ReasonDialog
        open={asking !== null}
        title={asking === "rejected" ? "Отказ по заявке" : "Вернуть заявку в работу"}
        confirm={asking === "rejected" ? "Отказать" : "Вернуть в работу"}
        busy={saver.saving}
        onClose={() => setAsking(null)}
        onConfirm={(reason) => asking && void move(asking, reason)}
        error={<FormError saver={saver} onRefresh={onReload} />}
      >
        <WasNow was={LEAD_STATUS_TEXT[lead.status]} now={asking ? LEAD_STATUS_TEXT[asking] : ""} />
        <p className="ac-text-body-s">
          {asking === "rejected"
            ? "Причину увидят администраторы в карточке и журнале. Заявку можно будет вернуть в работу."
            : "Заявка вернётся в работу; причина попадёт в журнал."}
        </p>
      </ReasonDialog>
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
  const add = async () => {
    if (!text.trim()) return;
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
    <section className="card-section">
      <h2 className="ac-text-heading">Заметки</h2>
      {card.notes.length === 0 ? (
        <p className="ac-text-body-s ac-muted">Заметок пока нет.</p>
      ) : (
        <ul className="plain-list notes-list">
          {card.notes.map((note) => (
            <li key={note.id}>
              <span className="ac-text-caption ac-muted num">{formatMoment(note.createdAt)}</span>
              <p className="ac-text-body-s long-text">{note.text}</p>
            </li>
          ))}
        </ul>
      )}
      <label className="textarea">
        <span className="ac-text-caption ac-muted">Новая заметка</span>
        <textarea
          value={text}
          rows={2}
          maxLength={2000}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="button-row">
        <Button
          variant="secondary"
          disabled={!online || !text.trim()}
          loading={saver.saving}
          onClick={add}
        >
          Добавить заметку
        </Button>
      </div>
      <FormError saver={saver} />
    </section>
  );
}
