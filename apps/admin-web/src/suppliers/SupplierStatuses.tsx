import type { AdminSupplierCard, AuditLogEntry } from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  LoadingContent,
  SkeletonList,
  todayIn,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AuditRow } from "../audit/Audit";
import { CLUB_TIME_ZONE, formatMoment } from "../format";
import { useLoad } from "../use-load";
import { FormError } from "../vehicles/shared";
import { ReasonDialog, useSupplierSaver, WasNow } from "./shared";
import { STATE_TEXT } from "./supplier-words";

type Action = "verify" | "unverify" | "pause" | "unpause" | "block" | "unblock";

const PAUSE_REASON_TEXT = { admin: "решение администратора", billing: "не оплачена подписка" };

const SHOWCASE_OFF =
  "Предложения компании будут сняты с витрины. Текущие заявки остаются в силе, кабинет остаётся открытым.";
const BLOCK_EFFECT =
  "Сотрудники не смогут принимать заявки, отмечать готовность, отказывать и добавлять коллег; приглашения не уходят. Выдача по коду останется.";

/** «Дата» of a contract as people read it: «12 сентября 2026». */
function dateText(date: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * «Статусы» of A-SUP-03 (SCREENS 7.0, 7.4; TASK-036): «проверенный
 * партнёр» with the date of the contract, the pause and the blocking — each
 * with a reason (the server refuses an empty one) and a confirmation that
 * says «было → стало» and what will happen; lifting — the same. Below, the
 * history of the states from the journal.
 */
export function SupplierStatuses({
  card,
  onChanged,
  onReload,
}: {
  card: AdminSupplierCard;
  onChanged: (card: AdminSupplierCard) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const saver = useSupplierSaver("supplier");
  const [action, setAction] = useState<Action | null>(null);
  const [contractDate, setContractDate] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  const today = todayIn(card.timeZone);
  const paused = card.pause !== null;
  const blocked = card.block !== null;

  const open = (next: Action) => {
    saver.reset();
    setAction(next);
  };

  const apply = async (reason?: string) => {
    if (!action) return;
    let next: AdminSupplierCard | null = null;
    const expectedVersion = saver.versionOf(card.version);
    const params = { supplierId: card.id };
    const done = await saver.run(card.id, async () => {
      switch (action) {
        case "verify":
          next = (
            await apiClient.setSupplierVerification(params, {
              expectedVersion,
              verified: true,
              contractSignedOn: contractDate,
            })
          ).supplier;
          break;
        case "unverify":
          next = (
            await apiClient.setSupplierVerification(params, {
              expectedVersion,
              verified: false,
              reason,
            })
          ).supplier;
          break;
        case "pause":
          next = (
            await apiClient.setSupplierPause(params, {
              expectedVersion,
              paused: true,
              reason: "admin",
              note: reason!,
            })
          ).supplier;
          break;
        case "unpause":
          next = (
            await apiClient.setSupplierPause(params, {
              expectedVersion,
              paused: false,
              note: reason!,
            })
          ).supplier;
          break;
        case "block":
          next = (
            await apiClient.setSupplierBlock(params, {
              expectedVersion,
              blocked: true,
              reason: reason!,
            })
          ).supplier;
          break;
        case "unblock":
          next = (
            await apiClient.setSupplierBlock(params, {
              expectedVersion,
              blocked: false,
              reason: reason!,
            })
          ).supplier;
          break;
      }
    });
    if (done && next) {
      const answer: AdminSupplierCard = next;
      setAction(null);
      saver.reset();
      onChanged(answer);
      setHistoryKey((key) => key + 1);
      toast.show(`Состояние: ${STATE_TEXT[answer.state]}`);
    }
  };

  const stateAfter = (change: { paused?: boolean; blocked?: boolean }) => {
    const willBlock = change.blocked ?? blocked;
    const willPause = change.paused ?? paused;
    return willBlock ? STATE_TEXT.blocked : willPause ? STATE_TEXT.paused : STATE_TEXT.active;
  };
  const showcaseNow = card.visibleOnShowcase ? "предложения на витрине" : "предложения скрыты";

  const reasonFor: Partial<Record<Action, { title: string; confirm: string; text: string }>> = {
    unverify: {
      title: "Снять отметку «Проверенный партнёр»",
      confirm: "Снять отметку",
      text: "Отметка пропадёт у предложений компании в приложении. На витрину это не влияет.",
    },
    pause: {
      title: "Поставить компанию на паузу",
      confirm: "Поставить на паузу",
      text: SHOWCASE_OFF,
    },
    unpause: {
      title: "Снять паузу",
      confirm: "Снять паузу",
      text: blocked
        ? "Компания остаётся заблокированной — предложения вернутся на витрину только после снятия блокировки."
        : "Предложения компании вернутся на витрину (если у точки заданы часы работы).",
    },
    block: {
      title: "Заблокировать компанию",
      confirm: "Заблокировать",
      text: `${SHOWCASE_OFF} ${BLOCK_EFFECT}`,
    },
    unblock: {
      title: "Снять блокировку",
      confirm: "Снять блокировку",
      text: paused
        ? "Сотрудники снова смогут принимать заявки и добавлять коллег. Компания остаётся на паузе — предложения на витрину не вернутся, пока пауза не снята."
        : "Сотрудники снова смогут принимать заявки и добавлять коллег; предложения вернутся на витрину (если у точки заданы часы работы).",
    },
  };
  const wasNow: Partial<Record<Action, [string, string]>> = {
    unverify: ["проверенный партнёр", "без отметки"],
    pause: [
      `${STATE_TEXT[card.state]}, ${showcaseNow}`,
      `${stateAfter({ paused: true })}, предложения скрыты`,
    ],
    unpause: [STATE_TEXT[card.state], stateAfter({ paused: false })],
    block: [
      `${STATE_TEXT[card.state]}, ${showcaseNow}`,
      `${STATE_TEXT.blocked}, предложения скрыты`,
    ],
    unblock: [STATE_TEXT[card.state], stateAfter({ blocked: false })],
  };
  const asking = action && action !== "verify" ? reasonFor[action] : undefined;

  return (
    <div className="detail-stack">
      {action === null && <FormError saver={saver} onRefresh={onReload} />}
      <section className="card-section">
        <h2 className="ac-text-heading">Проверенный партнёр</h2>
        {card.verification ? (
          <>
            <p className="ac-text-body">
              Договор подписан {dateText(card.verification.contractSignedOn)} · отмечен{" "}
              {formatMoment(card.verification.verifiedAt)}
            </p>
            <div className="button-row">
              <Button variant="secondary" disabled={!online} onClick={() => open("unverify")}>
                Снять отметку…
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="ac-text-body-s ac-muted">
              Отметка «Проверенный партнёр» ставится после подписания договора и видна клиентам у
              предложений компании.
            </p>
            <div className="filters">
              <label className="select">
                <span className="ac-text-caption ac-muted">Дата договора</span>
                <input
                  type="date"
                  value={contractDate}
                  max={today}
                  onChange={(event) => setContractDate(event.target.value)}
                />
              </label>
              <Button
                variant="secondary"
                disabled={!online || !contractDate || contractDate > today}
                onClick={() => open("verify")}
              >
                Отметить проверенным…
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="card-section">
        <h2 className="ac-text-heading">Пауза</h2>
        {card.pause ? (
          <>
            <Banner tone="warning">
              На паузе с {formatMoment(card.pause.since)} — {PAUSE_REASON_TEXT[card.pause.reason]}
              {card.pause.note ? `: ${card.pause.note}` : ""}. Предложения не видны клиентам.
            </Banner>
            <div className="button-row">
              <Button variant="secondary" disabled={!online} onClick={() => open("unpause")}>
                Снять паузу…
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="ac-text-body-s ac-muted">
              Пауза снимает предложения с витрины; кабинет и текущие заявки работают как обычно.
            </p>
            <div className="button-row">
              <Button variant="secondary" disabled={!online} onClick={() => open("pause")}>
                Поставить на паузу…
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="card-section">
        <h2 className="ac-text-heading">Блокировка</h2>
        {card.block ? (
          <>
            <Banner tone="danger">
              Заблокирована с {formatMoment(card.block.since)}: {card.block.reason}. {BLOCK_EFFECT}
            </Banner>
            <div className="button-row">
              <Button variant="secondary" disabled={!online} onClick={() => open("unblock")}>
                Снять блокировку…
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="ac-text-body-s ac-muted">
              Блокировка снимает предложения с витрины и закрывает работу с заявками, кроме выдачи
              по коду; сотрудников и приглашений добавлять нельзя.
            </p>
            <div className="button-row">
              <Button variant="danger" disabled={!online} onClick={() => open("block")}>
                Заблокировать…
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="card-section">
        <h2 className="ac-text-heading">История статусов</h2>
        <StatusHistory key={historyKey} supplierId={card.id} />
      </section>

      <ReasonDialog
        open={asking !== undefined}
        title={asking?.title ?? ""}
        confirm={asking?.confirm ?? ""}
        busy={saver.saving}
        onClose={() => setAction(null)}
        onConfirm={(reason) => void apply(reason)}
        error={<FormError saver={saver} onRefresh={onReload} />}
      >
        {action && wasNow[action] && <WasNow was={wasNow[action][0]} now={wasNow[action][1]} />}
        {asking && <p className="ac-text-body-s">{asking.text}</p>}
      </ReasonDialog>

      <Dialog
        open={action === "verify"}
        onClose={() => setAction(null)}
        title="Отметить «Проверенный партнёр»"
        actions={
          <>
            <Button onClick={() => void apply()} loading={saver.saving}>
              Отметить
            </Button>
            <Button variant="secondary" onClick={() => setAction(null)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <WasNow
            was="без отметки"
            now={contractDate ? `Договор подписан ${dateText(contractDate)}` : ""}
          />
          <p className="ac-text-body-s">
            Клиенты увидят отметку у предложений компании. На витрину и заявки это не влияет.
          </p>
          <FormError saver={saver} onRefresh={onReload} />
        </div>
      </Dialog>
    </div>
  );
}

const STATUS_ACTIONS = [
  "supplier.verification_changed",
  "supplier.pause_changed",
  "supplier.block_changed",
] as const;

/** The journal of the three states, newest first (the last 30 of each). */
function StatusHistory({ supplierId }: { supplierId: string }) {
  const history = useLoad<AuditLogEntry[]>(async () => {
    const pages = await Promise.all(
      STATUS_ACTIONS.map((action) =>
        apiClient.listAuditLog({
          query: { entityType: "supplier", entityId: supplierId, action, limit: 30 },
        }),
      ),
    );
    return pages.flatMap((page) => page.entries).sort((a, b) => b.at.localeCompare(a.at));
  }, `status-history:${supplierId}`);
  const entries = history.data ?? [];
  return (
    <LoadingContent
      ready={history.data !== undefined}
      indicator={history.indicator}
      label="Загрузка"
      skeleton={<SkeletonList rows={3} label="Загрузка" />}
    >
      {entries.length === 0 ? (
        <EmptyState icon="clock" title="Статусы не менялись" />
      ) : (
        <div className="table-wrap">
          <table className="admin-table audit-table">
            <caption className="ac-visually-hidden">
              История статусов, время — Алматы ({CLUB_TIME_ZONE})
            </caption>
            <thead>
              <tr>
                <th scope="col">Время</th>
                <th scope="col">Кто</th>
                <th scope="col">Действие и объект</th>
                <th scope="col">Было → стало</th>
                <th scope="col">Причина</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </LoadingContent>
  );
}
