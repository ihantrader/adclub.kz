import type { AdminSupplierCard, AuditLogEntry } from "@adclub/contracts";
import {
  Badge,
  Button,
  DateField,
  Dialog,
  EmptyState,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  todayIn,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { JournalTable } from "../audit/JournalTable";
import { formatDay, formatMoment } from "../format";
import { useLoad } from "../use-load";
import { ReasonDialog, SaverError, useSupplierSaver, WasNow } from "./shared";
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
 * «Статусы» of A-SUP-03 (SCREENS 7.0, 7.4; TASK-036, TASK-080): three row-cards — «проверенный
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
  const [dateProblem, setDateProblem] = useState<string | null>(null);
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
      {action === null && <SaverError saver={saver} onRefresh={onReload} />}
      <div className="status-rows">
        <StatusRow
          title="Проверенный партнёр"
          text="Отметка ставится после подписания договора и видна клиентам у предложений компании."
          badge={
            card.verification ? (
              <Badge tone="success" icon="circleCheck">
                Да, договор от {card.verification.contractSignedOn.split("-").reverse().join(".")}
              </Badge>
            ) : (
              <Badge tone="neutral" icon="minus">
                Нет
              </Badge>
            )
          }
          note={
            card.verification ? `Отмечен ${formatMoment(card.verification.verifiedAt)}` : undefined
          }
          action={
            card.verification ? (
              <Button
                variant="secondary"
                size="s"
                disabled={!online}
                onClick={() => open("unverify")}
              >
                Снять отметку…
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="s"
                disabled={!online}
                onClick={() => {
                  setContractDate("");
                  setDateProblem(null);
                  open("verify");
                }}
              >
                Отметить проверенным…
              </Button>
            )
          }
        />
        <StatusRow
          title="Пауза"
          text="Пауза снимает предложения с витрины; кабинет и текущие заявки работают как обычно."
          badge={
            card.pause ? (
              <StatusBadge kind="supplier" status="paused">
                На паузе с {formatDay(card.pause.since)}
              </StatusBadge>
            ) : (
              <Badge tone="neutral" icon="minus">
                Нет
              </Badge>
            )
          }
          note={
            card.pause
              ? `${PAUSE_REASON_TEXT[card.pause.reason]}${card.pause.note ? `: ${card.pause.note}` : ""}. Предложения не видны клиентам.`
              : undefined
          }
          action={
            <Button
              variant="secondary"
              size="s"
              disabled={!online}
              onClick={() => open(card.pause ? "unpause" : "pause")}
            >
              {card.pause ? "Снять паузу…" : "Поставить на паузу…"}
            </Button>
          }
        />
        <StatusRow
          title="Блокировка"
          text="Блокировка снимает предложения с витрины и закрывает работу с заявками, кроме выдачи по коду; сотрудников и приглашений добавлять нельзя."
          badge={
            card.block ? (
              <StatusBadge kind="supplier" status="blocked">
                Заблокирована с {formatDay(card.block.since)}
              </StatusBadge>
            ) : (
              <Badge tone="neutral" icon="minus">
                Нет
              </Badge>
            )
          }
          note={card.block ? `${card.block.reason}. ${BLOCK_EFFECT}` : undefined}
          action={
            card.block ? (
              <Button
                variant="secondary"
                size="s"
                disabled={!online}
                onClick={() => open("unblock")}
              >
                Снять блокировку…
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="s"
                destructive
                disabled={!online}
                onClick={() => open("block")}
              >
                Заблокировать…
              </Button>
            )
          }
        />
      </div>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">История статусов</h2>
        </div>
        <StatusHistory key={historyKey} supplierId={card.id} />
      </section>

      <ReasonDialog
        open={asking !== undefined}
        title={asking?.title ?? ""}
        confirm={asking?.confirm ?? ""}
        busy={saver.saving}
        onClose={() => setAction(null)}
        onConfirm={(reason) => void apply(reason)}
        error={<SaverError saver={saver} onRefresh={onReload} />}
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
            <Button
              onClick={() => {
                if (!contractDate) {
                  setDateProblem("Укажите дату договора");
                  return;
                }
                void apply();
              }}
              loading={saver.saving}
            >
              Отметить
            </Button>
            <Button variant="secondary" onClick={() => setAction(null)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <DateField
            label="Дата договора"
            value={contractDate}
            max={today}
            today={today}
            locale="ru"
            error={
              dateProblem ?? (saver.error?.field === "contractSignedOn" ? saver.error.text : null)
            }
            onChange={(date) => {
              setContractDate(date);
              setDateProblem(null);
            }}
          />
          <WasNow
            was="без отметки"
            now={
              contractDate ? `Договор подписан ${dateText(contractDate)}` : "проверенный партнёр"
            }
          />
          <p className="ac-text-body-s">
            Клиенты увидят отметку у предложений компании. На витрину и заявки это не влияет.
          </p>
          <SaverError saver={saver} fields={["contractSignedOn"]} onRefresh={onReload} />
        </div>
      </Dialog>
    </div>
  );
}

/**
 * One state of the company as a row-card (TASK-080): its name and what it
 * does, the state now as a badge, one button on the right.
 */
function StatusRow({
  title,
  text,
  badge,
  note,
  action,
}: {
  title: string;
  text: string;
  badge: ReactNode;
  note?: string;
  action: ReactNode;
}) {
  return (
    <section className="card status-row">
      <div className="status-row__main">
        <h2 className="status-row__title">{title}</h2>
        <p className="section__note">{text}</p>
        {note && <p className="ac-text-body-s status-row__note">{note}</p>}
      </div>
      <div className="status-row__state">{badge}</div>
      <div className="status-row__action">{action}</div>
    </section>
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
        <EmptyState compact icon="history" title="Статусы не менялись" />
      ) : (
        <JournalTable entries={entries} caption="История статусов" selfId={supplierId} />
      )}
    </LoadingContent>
  );
}
