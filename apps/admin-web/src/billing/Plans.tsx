import { isApiError } from "@adclub/api-client";
import type { AdminBillingPlans, AdminPlan, Setting } from "@adclub/contracts";
import { earliestPlanStart, planInEffect } from "@adclub/domain";
import {
  Banner,
  Button,
  DateField,
  Dialog,
  IconButton,
  LoadingContent,
  SkeletonList,
  TextAreaField,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { conflictText } from "../catalog/catalog-words";
import { actorText } from "../audit/audit-words";
import { actionErrorText } from "../errors";
import { formatDay, formatMoment } from "../format";
import { Header, Muted, Table } from "../layout/layout";
import { SettingDialog } from "../settings/SettingDialog";
import { amountText } from "../suppliers/billing-words";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import {
  billingTabs,
  dayStart,
  PLAN_BY_TEXT,
  PLAN_STATE_TEXT,
  planDay,
  planLine,
  planRefusal,
  withPeriod,
} from "./billing-words";
import "./billing.css";

const NOTICE_KEY = "price_increase_notice_text";

/** Who changed the tariffs last, for «Эти данные только что изменил {кто}»: the newest journal entry. */
async function lastPlanChange(): Promise<string | null> {
  try {
    const page = await apiClient.listAuditLog({ query: { entityType: "plan", limit: 1 } });
    const entry = page.entries[0];
    return entry ? actorText(entry.actor) : null;
  } catch {
    return null;
  }
}

/** What the page knows of the records to tell a rise from a lowering (the server decides). */
function riseAt(plans: AdminBillingPlans, startsOn: string, price: number): boolean {
  const live = plans.supplier.records
    .filter((row) => row.state !== "cancelled")
    .map((row) => ({
      ...row,
      validFrom: new Date(row.validFrom),
      validTo: row.validTo ? new Date(row.validTo) : null,
    }));
  const before = planInEffect(
    live,
    "supplier",
    new Date(new Date(dayStart(startsOn)).getTime() - 1),
  );
  return before !== null && price > before.price;
}

/**
 * A-BILL-04 «Тарифы» (SCREENS 7.8; TASK-043): the suppliers' tariff in
 * effect, the announced and the planned changes, every record with who made
 * it and why (cancelled ones too). «Запланировать изменение…» — a price from
 * a later day of Almaty with its notice, «было → стало» before it is sent;
 * «Отменить…» — only what has not started. The tariff in effect is never
 * edited: a change is a new record (I783). Users' prices are the stores':
 * only the records are shown and the notice text, which is changed as a
 * setting is — the same dialog, the same version and reason.
 */
export function Plans() {
  const plans = useLoad(() => apiClient.getAdminBillingPlans(), "plans");
  const settings = useLoad(() => apiClient.listSettings(), "settings");
  const [planning, setPlanning] = useState(false);
  const [cancelling, setCancelling] = useState<AdminPlan | null>(null);
  const [editing, setEditing] = useState<Setting | null>(null);
  const data = plans.data;
  const notice =
    settings.data?.groups
      .flatMap((group) => group.settings)
      .find((row) => row.key === NOTICE_KEY) ?? null;

  return (
    <>
      <Header
        title="Биллинг"
        tabs={billingTabs("plans")}
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={plans.reload} />}
      />
      <LoadError error={plans.error} retry={plans.reload} />
      <LoadingContent
        ready={data !== undefined}
        indicator={plans.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {data && (
          <div className="billing-sections">
            <section aria-labelledby="plans-supplier" className="billing-plan">
              <div className="billing-plan__head">
                <h2 id="plans-supplier" className="ac-text-title-s">
                  Тариф поставщиков
                </h2>
                <Button onClick={() => setPlanning(true)}>Запланировать изменение…</Button>
              </div>
              {data.supplier.inEffect ? (
                <p className="ac-text-body">
                  Сейчас — {amountText(data.supplier.inEffect.price)} в месяц (с{" "}
                  {formatDay(data.supplier.inEffect.validFrom)}).
                </p>
              ) : (
                <Banner tone="warning">
                  Тариф поставщиков не задан: подписку нельзя начать и продлить. Первый тариф можно
                  начать сегодня.
                </Banner>
              )}
              {data.supplier.announced && (
                <p className="ac-text-body">
                  {planLine(data.supplier.announced)} — поставщики видят это в кабинете с{" "}
                  {withPeriod(formatDay(data.supplier.announced.announceFrom))}
                </p>
              )}
              <PlanTable
                label="Записи тарифа поставщиков"
                records={data.supplier.records}
                onCancel={setCancelling}
              />
            </section>

            <section aria-labelledby="plans-user" className="billing-plan">
              <h2 id="plans-user" className="ac-text-title-s">
                Подписка пользователей
              </h2>
              <p className="ac-text-body ac-muted">
                Цены пользователей задаются в App Store и Google Play и меняются там. Здесь — записи
                тарифа для сведения и текст, которым приложение предупреждает о повышении.
              </p>
              {data.user.records.length > 0 ? (
                <PlanTable label="Записи тарифа пользователей" records={data.user.records} />
              ) : (
                <p className="ac-text-body-s ac-muted">Записей тарифа пользователей нет</p>
              )}
              <div className="billing-notice">
                <div className="billing-plan__head">
                  <h3 className="ac-text-body-strong">Текст анонса повышения</h3>
                  <Button
                    variant="secondary"
                    size="s"
                    disabled={!notice}
                    onClick={() => setEditing(notice)}
                  >
                    Изменить…
                  </Button>
                </div>
                {notice && typeof notice.value === "object" && notice.value !== null ? (
                  <dl className="billing-notice__texts">
                    {(["ru", "kk", "en"] as const).map((lang) => (
                      <div key={lang}>
                        <dt className="ac-text-caption ac-muted">{lang.toUpperCase()}</dt>
                        <dd className="ac-text-body-s">
                          {(notice.value as Record<string, string>)[lang] ?? "—"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <Muted>{settings.error ? "Не удалось загрузить настройку" : "Загрузка…"}</Muted>
                )}
              </div>
            </section>
          </div>
        )}
      </LoadingContent>
      {data && (
        <PlanDialog
          open={planning}
          plans={data}
          onClose={() => setPlanning(false)}
          onSaved={(fresh) => {
            plans.replace(fresh);
            setPlanning(false);
          }}
          reload={plans.reload}
        />
      )}
      {data && (
        <CancelDialog
          plan={cancelling}
          version={data.version}
          onClose={() => setCancelling(null)}
          onSaved={(fresh) => {
            plans.replace(fresh);
            setCancelling(null);
          }}
          reload={plans.reload}
        />
      )}
      <SettingDialog
        setting={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          settings.reload();
        }}
        reloadSetting={async (key) => {
          const fresh = await apiClient.listSettings();
          return (
            fresh.groups.flatMap((group) => group.settings).find((row) => row.key === key) ?? null
          );
        }}
      />
    </>
  );
}

function PlanTable({
  label,
  records,
  onCancel,
}: {
  label: string;
  records: readonly AdminPlan[];
  onCancel?: (plan: AdminPlan) => void;
}) {
  return (
    <Table
      label={label}
      columns={[
        { key: "from", header: "С какого дня", width: 140 },
        { key: "price", header: "Цена в месяц", width: 130, numeric: true },
        { key: "state", header: "Состояние", width: 190 },
        { key: "announce", header: "Анонс", width: 170 },
        { key: "reason", header: "Причина" },
        { key: "by", header: "Кто завёл", width: 170 },
        ...(onCancel
          ? [{ key: "actions", header: "Действия", actions: true, hiddenHeader: true }]
          : []),
      ]}
    >
      {records.map((plan) => {
        const future = plan.state === "announced" || plan.state === "scheduled";
        return (
          <tr
            key={plan.id}
            className={plan.state === "cancelled" ? "billing-row--cancelled" : undefined}
          >
            <td className="ac-text-body-s nowrap">{formatDay(plan.validFrom)}</td>
            <td className="num">{amountText(plan.price)}</td>
            <td className="ac-text-body-s">
              {PLAN_STATE_TEXT[plan.state]}
              {plan.cancelled && (
                <Muted>
                  {" "}
                  · {formatMoment(plan.cancelled.at)}: {plan.cancelled.reason}
                </Muted>
              )}
            </td>
            <td className="ac-text-body-s">
              за {plan.announceBeforeDays.toLocaleString("ru-RU")} дн.
              <Muted> · с {formatDay(plan.announceFrom)}</Muted>
            </td>
            <td className="ac-text-body-s">{plan.reason}</td>
            <td className="ac-text-body-s">
              {PLAN_BY_TEXT[plan.createdByRole]}
              <Muted> · {formatDay(plan.createdAt)}</Muted>
            </td>
            {onCancel && (
              <td className="admin-table__actions">
                {future && (
                  <Button variant="text" size="s" onClick={() => onCancel(plan)}>
                    Отменить…
                  </Button>
                )}
              </td>
            )}
          </tr>
        );
      })}
    </Table>
  );
}

/** The days of a number field: digits only. */
function digits(text: string): string {
  return text.replace(/\D/g, "");
}

function PlanDialog({
  open,
  plans,
  onClose,
  onSaved,
  reload,
}: {
  open: boolean;
  plans: AdminBillingPlans;
  onClose: () => void;
  onSaved: (plans: AdminBillingPlans) => void;
  reload: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const [price, setPrice] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [days, setDays] = useState("7");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<
    Partial<Record<"price" | "startsOn" | "announceBeforeDays" | "reason", string>>
  >({});
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [saving, setSaving] = useState(false);

  const amount = Number(price);
  const announceDays = Number(days);
  const complete =
    Number.isInteger(amount) &&
    amount >= 1 &&
    startsOn !== "" &&
    days !== "" &&
    reason.trim() !== "";
  const rise = complete ? riseAt(plans, startsOn, amount) : false;
  const earliest = earliestPlanStart({
    now: new Date(),
    announceBeforeDays: announceDays,
    rise,
    firstTariff: plans.supplier.inEffect === null,
  });
  const announceFrom = startsOn
    ? new Date(new Date(dayStart(startsOn)).getTime() - announceDays * 86_400_000).toISOString()
    : null;

  const close = () => {
    setChecking(false);
    setErrors({});
    setFailure(null);
    setConflict(false);
    onClose();
  };

  const check = () => {
    const found: typeof errors = {};
    if (!Number.isInteger(amount) || amount < 1) found.price = "Цена — целое число тенге от 1";
    if (!startsOn) found.startsOn = "Выберите день начала";
    else if (startsOn < earliest) {
      found.startsOn = rise
        ? `Повышение можно начать не раньше ${formatDay(dayStart(earliest))}: поставщиков нужно предупредить заранее`
        : `Тариф можно начать не раньше ${formatDay(dayStart(earliest))}`;
    }
    if (days === "") found.announceBeforeDays = "Укажите, за сколько дней предупредить";
    else if (rise && announceDays < 1)
      found.announceBeforeDays = "О повышении нужно предупредить хотя бы за день";
    if (!reason.trim()) found.reason = "Укажите причину";
    setErrors(found);
    if (Object.keys(found).length === 0) {
      setCheckedAt(Date.now());
      setChecking(true);
    }
  };

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const fresh = await apiClient.addAdminBillingPlan({
        price: amount,
        startsOn,
        announceBeforeDays: announceDays,
        reason: reason.trim(),
        expectedVersion: plans.version,
      });
      toast.show("Изменение тарифа запланировано");
      setPrice("");
      setStartsOn("");
      setReason("");
      setChecking(false);
      onSaved(fresh);
    } catch (thrown) {
      const refusal = planRefusal(thrown);
      if (refusal?.field) {
        setChecking(false);
        setErrors({ [refusal.field]: refusal.text });
      } else if (isApiError(thrown) && thrown.code === "PLAN_VERSION_CONFLICT") {
        setConflict(true);
        setFailure(conflictText(await lastPlanChange()));
      } else {
        setFailure(actionErrorText(thrown));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={checking ? "Проверьте изменение тарифа" : "Запланировать изменение тарифа"}
      actions={
        checking ? (
          <>
            <Button variant="secondary" onClick={() => setChecking(false)} disabled={saving}>
              Назад
            </Button>
            <Button onClick={save} loading={saving} disabled={!online}>
              Запланировать
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Отмена
            </Button>
            <Button onClick={check}>Продолжить</Button>
          </>
        )
      }
    >
      {checking && announceFrom ? (
        <div className="billing-preview">
          <p>
            Было:{" "}
            {plans.supplier.inEffect
              ? `${amountText(plans.supplier.inEffect.price)} в месяц`
              : "тарифа нет"}
          </p>
          <p className="ac-text-body-strong">
            Стало: {planLine({ validFrom: dayStart(startsOn), price: amount })}
          </p>
          <p>
            {new Date(announceFrom).getTime() <= checkedAt
              ? "Поставщики увидят это в кабинете сразу."
              : withPeriod(`Поставщики увидят это с ${formatDay(announceFrom)}`)}
          </p>
          <p className="ac-muted">Причина: {reason.trim()}</p>
        </div>
      ) : (
        <div className="billing-form">
          <TextField
            label="Цена, ₸ в месяц"
            value={price}
            inputMode="numeric"
            maxLength={7}
            onChange={(text) => setPrice(digits(text))}
            error={errors.price}
            hint={
              plans.supplier.inEffect
                ? `Сейчас — ${amountText(plans.supplier.inEffect.price)}`
                : undefined
            }
          />
          <TextField
            label="Предупредить за, дней"
            value={days}
            inputMode="numeric"
            maxLength={3}
            onChange={(text) => setDays(digits(text))}
            error={errors.announceBeforeDays}
            hint="Столько дней до начала поставщики видят в кабинете анонс нового тарифа"
          />
          <DateField
            label="Дата начала"
            value={startsOn}
            locale="ru"
            min={earliest}
            today={plans.today}
            onChange={setStartsOn}
            error={errors.startsOn}
            hint={`День по Алматы. Не раньше ${formatDay(dayStart(earliest))}${rise ? " — повышение" : ""}`}
          />
          <TextAreaField
            label="Причина"
            value={reason}
            onChange={setReason}
            error={errors.reason}
          />
        </div>
      )}
      {failure && (
        <Banner
          tone="danger"
          action={
            conflict ? (
              <Button
                variant="text"
                size="s"
                onClick={() => {
                  setConflict(false);
                  setFailure(null);
                  reload();
                }}
              >
                Обновить данные
              </Button>
            ) : undefined
          }
        >
          {failure}
        </Banner>
      )}
    </Dialog>
  );
}

function CancelDialog({
  plan,
  version,
  onClose,
  onSaved,
  reload,
}: {
  plan: AdminPlan | null;
  version: number;
  onClose: () => void;
  onSaved: (plans: AdminBillingPlans) => void;
  reload: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const close = () => {
    setReason("");
    setError(null);
    setFailure(null);
    setConflict(false);
    onClose();
  };

  const save = async () => {
    if (!plan) return;
    if (!reason.trim()) {
      setError("Укажите причину");
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const fresh = await apiClient.cancelAdminBillingPlan(
        { planId: plan.id },
        { reason: reason.trim(), expectedVersion: version },
      );
      toast.show("Запланированное изменение отменено");
      setReason("");
      onSaved(fresh);
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "PLAN_VERSION_CONFLICT") {
        setConflict(true);
        setFailure(conflictText(await lastPlanChange()));
      } else if (isApiError(thrown) && thrown.code === "PLAN_NOT_CANCELLABLE") {
        setConflict(true);
        setFailure(
          "Этот тариф уже начал действовать или уже отменён — отменить можно только то, что ещё впереди",
        );
      } else {
        setFailure(actionErrorText(thrown));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={plan !== null}
      onClose={close}
      title="Отменить запланированное изменение?"
      actions={
        <>
          <Button variant="secondary" onClick={close} disabled={saving}>
            Не отменять
          </Button>
          <Button variant="danger" onClick={save} loading={saving} disabled={!online}>
            Отменить изменение
          </Button>
        </>
      }
    >
      {plan && (
        <>
          <p className="ac-text-body-strong">{planLine(plan)}</p>
          <p>
            {plan.state === "announced"
              ? "Поставщики уже видят этот анонс: после отмены он пропадёт из кабинета."
              : `Анонс ещё не показывался (поставщики увидели бы его с ${formatDay(plan.announceFrom)}).`}{" "}
            Запись останется в истории с пометкой «Отменён». С {formatDay(dayStart(planDay(plan)))}{" "}
            продолжит действовать прежний тариф.
          </p>
          <TextAreaField label="Причина" value={reason} onChange={setReason} error={error} />
        </>
      )}
      {failure && (
        <Banner
          tone="danger"
          action={
            conflict ? (
              <Button
                variant="text"
                size="s"
                onClick={() => {
                  close();
                  reload();
                }}
              >
                Обновить данные
              </Button>
            ) : undefined
          }
        >
          {failure}
        </Banner>
      )}
    </Dialog>
  );
}
