import { isApiError } from "@adclub/api-client";
import type { AdministratorListResponse, AdministratorSummary } from "@adclub/contracts";
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Dialog,
  LoadingContent,
  MenuButton,
  SkeletonList,
  TextAreaField,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { actionErrorText, loadErrorText, signInErrorText } from "../errors";
import { formatMoment } from "../format";
import { Header, Table, type Column } from "../layout/layout";
import { BackupCodes } from "../screens/BackupCodes";
import { reasonProblem } from "../settings/setting-rules";
import { useLoad } from "../use-load";
import {
  BACKUP_CODES_LOW,
  setBackupCodesRemaining,
  useBackupCodesRemaining,
} from "./backup-reminder";
import "./security.css";

const COLUMNS: Column[] = [
  { key: "admin", header: "Администратор" },
  { key: "factor", header: "Второй фактор", width: 220 },
  { key: "signIn", header: "Последний вход", width: 180 },
  { key: "actions", header: "Действия", width: 72, actions: true, hiddenHeader: true },
];

/**
 * «Безопасность» (SCREENS 7.0; TASK-034 requirement 6, TASK-080): one's own
 * new backup codes (the current code of the authenticator confirms it is
 * really them; shown once), and the administrators — all equal — with
 * «Сбросить второй фактор…» for another one in «⋯», with the reason.
 * Administrators are appointed and removed only by the server operator:
 * there are no buttons for that.
 */
export function Security({ currentAdminId }: { currentAdminId: string | null }) {
  const admins = useLoad<AdministratorListResponse>(
    () => apiClient.listAdministrators(),
    "administrators",
  );
  const [resetting, setResetting] = useState<AdministratorSummary | null>(null);

  return (
    <>
      <Header title="Безопасность" />
      <div className="detail-stack">
        <MySecondFactor />

        <section className="section" aria-labelledby="admins-title">
          <div className="section__head">
            <h2 id="admins-title" className="section__title">
              Администраторы
            </h2>
          </div>
          <p className="section__note">
            Все администраторы равноправны. Назначает и снимает администраторов только оператор
            сервера.
          </p>
          {admins.error !== undefined && (
            <Banner
              tone="danger"
              action={
                <Button variant="text" size="s" onClick={admins.reload}>
                  Повторить
                </Button>
              }
            >
              {loadErrorText(admins.error)}
            </Banner>
          )}
          <LoadingContent
            ready={admins.data !== undefined}
            indicator={admins.indicator}
            label="Загрузка"
            skeleton={<SkeletonList rows={2} label="Загрузка" />}
          >
            <Table label="Администраторы" columns={COLUMNS}>
              {(admins.data?.administrators ?? []).map((admin) => {
                const self = admin.current || admin.id === currentAdminId;
                return (
                  <tr key={admin.id}>
                    <td>
                      <span className="row-title">
                        {admin.name ? (
                          <span className="ac-text-body-strong security-name">
                            {admin.name}
                            {self && <span className="ac-muted"> (вы)</span>}
                          </span>
                        ) : (
                          <span className="ac-text-body-s ac-muted security-name">
                            Имя не указано
                            {self && " (вы)"}
                          </span>
                        )}
                        <span className="ac-text-body-s ac-muted">{admin.phoneMasked}</span>
                      </span>
                    </td>
                    <td>
                      {admin.totpConfigured ? (
                        <span className="ac-text-body-s">Настроен</span>
                      ) : (
                        <span className="cell-stack">
                          <Badge tone="warning" icon="alertTriangle">
                            Не настроен
                          </Badge>
                          <span className="ac-text-caption ac-muted">настроит при входе</span>
                        </span>
                      )}
                    </td>
                    <td className="ac-text-body-s nowrap">
                      {admin.lastSignInAt ? (
                        formatMoment(admin.lastSignInAt)
                      ) : (
                        <span className="ac-muted">Не входил</span>
                      )}
                    </td>
                    <td className="admin-table__actions">
                      {!self && admin.totpConfigured && (
                        <div className="row-actions">
                          <MenuButton
                            size="s"
                            label={`Действия с администратором ${admin.name ?? admin.phoneMasked}`}
                            actions={[
                              {
                                key: "reset",
                                label: "Сбросить второй фактор…",
                                icon: "lock",
                                destructive: true,
                                onSelect: () => setResetting(admin),
                              },
                            ]}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          </LoadingContent>
        </section>
      </div>

      <ResetDialog
        admin={resetting}
        onCancel={() => setResetting(null)}
        onDone={() => {
          setResetting(null);
          admins.reload();
        }}
      />
    </>
  );
}

/**
 * «Мой второй фактор»: new backup codes. How many are left is shown only
 * when the server said it — the answer of the sign-in in this page (after a
 * reload it is not known); the server gives no date of the set, so there is
 * none here.
 */
function MySecondFactor() {
  const online = useOnline();
  const remaining = useBackupCodesRemaining();
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const create = async (value: string) => {
    setError(null);
    try {
      const answer = await apiClient.regenerateBackupCodes({ totpCode: value });
      setCodes(answer.backupCodes);
      setBackupCodesRemaining(null);
      setAsking(false);
      setCode("");
    } catch (thrown) {
      setCode("");
      setError(
        isApiError(thrown) && (thrown.code === "TOTP_INVALID" || thrown.code === "RATE_LIMITED")
          ? signInErrorText(thrown)
          : actionErrorText(thrown),
      );
    }
  };

  const close = () => {
    setAsking(false);
    setCode("");
    setError(null);
  };

  return (
    <section className="card" aria-labelledby="my-factor-title">
      <h2 id="my-factor-title" className="card__title">
        Мой второй фактор
      </h2>
      {codes ? (
        <div className="codes-panel">
          <BackupCodes codes={codes} doneLabel="Готово" onDone={() => setCodes(null)} />
        </div>
      ) : (
        <>
          <p className="ac-text-body-s ac-muted security-text">
            Резервные коды нужны, если телефона с приложением-аутентификатором нет под рукой. Новые
            коды отменяют все прежние.
          </p>
          {remaining !== null && (
            <span className="badges">
              {remaining <= BACKUP_CODES_LOW ? (
                <Badge tone="warning" icon="alertTriangle">
                  {remaining === 0
                    ? "Резервные коды закончились"
                    : `Осталось резервных кодов: ${remaining.toLocaleString("ru-RU")}`}
                </Badge>
              ) : (
                <span className="ac-text-body-s">
                  Осталось резервных кодов: {remaining.toLocaleString("ru-RU")}
                </span>
              )}
            </span>
          )}
          <ActionBar
            compact
            label="Резервные коды"
            others={[
              <Button
                key="codes"
                variant="secondary"
                icon="refresh"
                disabled={!online}
                onClick={() => setAsking(true)}
              >
                Новые резервные коды
              </Button>,
            ]}
          />
        </>
      )}
      <Dialog
        open={asking}
        onClose={close}
        title="Новые резервные коды"
        actions={
          <Button variant="secondary" onClick={close}>
            Отмена
          </Button>
        }
      >
        <div className="dialog-stack">
          <p>
            Введите код из приложения-аутентификатора. Прежние резервные коды перестанут
            действовать.
          </p>
          <TextField
            label="Код из приложения"
            value={code}
            onChange={(value) => {
              const digits = value.replace(/\D/g, "").slice(0, 6);
              setCode(digits);
              if (digits.length === 6) void create(digits);
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            error={error ?? undefined}
          />
        </div>
      </Dialog>
    </section>
  );
}

function ResetDialog({
  admin,
  onCancel,
  onDone,
}: {
  admin: AdministratorSummary | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (admin && shownFor !== admin.id) {
    setShownFor(admin.id);
    setReason("");
    setError(null);
  }

  const submit = async () => {
    if (!admin) return;
    const problem = reasonProblem(reason);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      const answer = await apiClient.resetAdministratorSecondFactor(
        { adminId: admin.id },
        { reason: reason.trim() },
      );
      toast.show(`Второй фактор сброшен, завершено сессий: ${answer.sessionsEnded}`);
      onDone();
    } catch (thrown) {
      setError(
        isApiError(thrown) && thrown.code === "TOTP_SELF_RESET_FORBIDDEN"
          ? "Свой второй фактор сбросить нельзя — это делает другой администратор"
          : actionErrorText(thrown),
      );
    }
  };

  return (
    <Dialog
      open={admin !== null}
      onClose={onCancel}
      title="Сбросить второй фактор?"
      actions={
        <>
          <Button variant="danger" onClick={submit}>
            Сбросить
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
        </>
      }
    >
      {admin && (
        <div className="dialog-stack">
          <p>
            Администратор {admin.name ?? admin.phoneMasked}. Что произойдёт: все его сессии в
            админке сразу завершатся, приложение-аутентификатор и резервные коды перестанут
            действовать, при следующем входе он настроит второй фактор заново.
          </p>
          <TextAreaField
            label="Причина (обязательно, попадёт в журнал)"
            value={reason}
            rows={2}
            maxLength={500}
            onChange={(value) => {
              setReason(value);
              setError(null);
            }}
            error={error ?? undefined}
          />
        </div>
      )}
    </Dialog>
  );
}
