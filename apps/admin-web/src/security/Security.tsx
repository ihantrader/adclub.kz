import { isApiError } from "@adclub/api-client";
import type { AdministratorListResponse, AdministratorSummary } from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  LoadingContent,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { actionErrorText, loadErrorText, signInErrorText } from "../errors";
import { formatMoment } from "../format";
import { BackupCodes } from "../screens/BackupCodes";
import { reasonProblem } from "../settings/setting-rules";
import { useLoad } from "../use-load";
import { setBackupCodesRemaining } from "./backup-reminder";

/**
 * «Безопасность» (SCREENS 7.0; TASK-034 requirement 6): one's own new backup
 * codes (the current code of the authenticator confirms it is really them;
 * shown once), and the administrators — all equal — with «Сбросить второй
 * фактор» for another one, with the reason. Administrators are appointed and
 * removed only by the server operator: there are no buttons for that.
 */
export function Security({ currentAdminId }: { currentAdminId: string | null }) {
  const admins = useLoad<AdministratorListResponse>(
    () => apiClient.listAdministrators(),
    "administrators",
  );
  const [resetting, setResetting] = useState<AdministratorSummary | null>(null);

  return (
    <>
      <h1 className="ac-text-title-l page__title">Безопасность</h1>
      <MySecondFactor />

      <section className="card-section" aria-labelledby="admins-title">
        <h2 id="admins-title" className="ac-text-heading">
          Администраторы
        </h2>
        <p className="ac-text-body-s ac-muted">
          Все администраторы равноправны. Назначает и снимает администраторов только оператор
          сервера (команды <code>admin:grant</code> и <code>admin:revoke</code>).
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
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Администратор</th>
                  <th scope="col">Второй фактор</th>
                  <th scope="col">Последний вход</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
                {(admins.data?.administrators ?? []).map((admin) => {
                  const self = admin.current || admin.id === currentAdminId;
                  return (
                    <tr key={admin.id}>
                      <td>
                        <div className="cell-stack">
                          <span className="ac-text-body-strong">
                            {admin.name ?? admin.phoneMasked}
                            {self ? " (вы)" : ""}
                          </span>
                          {admin.name && (
                            <span className="ac-text-caption ac-muted num">
                              {admin.phoneMasked}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        {admin.totpConfigured ? (
                          "Настроен"
                        ) : (
                          <span className="warning-text">Не настроен — настроит при входе</span>
                        )}
                      </td>
                      <td className="num">
                        {admin.lastSignInAt ? formatMoment(admin.lastSignInAt) : "Не входил"}
                      </td>
                      <td className="admin-table__actions">
                        {!self && admin.totpConfigured && (
                          <Button variant="secondary" size="s" onClick={() => setResetting(admin)}>
                            Сбросить второй фактор…
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </LoadingContent>
      </section>

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

function MySecondFactor() {
  const online = useOnline();
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

  return (
    <section className="card-section" aria-labelledby="my-factor-title">
      <h2 id="my-factor-title" className="ac-text-heading">
        Мой второй фактор
      </h2>
      {codes ? (
        <div className="codes-panel">
          <BackupCodes codes={codes} doneLabel="Готово" onDone={() => setCodes(null)} />
        </div>
      ) : (
        <>
          <p className="ac-text-body-s ac-muted">
            Резервные коды нужны, если телефона с приложением-аутентификатором нет под рукой. Новые
            коды отменяют все прежние.
          </p>
          <div className="button-row">
            <Button
              variant="secondary"
              icon="refresh"
              disabled={!online}
              onClick={() => setAsking(true)}
            >
              Новые резервные коды
            </Button>
          </div>
        </>
      )}
      <Dialog
        open={asking}
        onClose={() => {
          setAsking(false);
          setCode("");
          setError(null);
        }}
        title="Новые резервные коды"
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              setAsking(false);
              setCode("");
              setError(null);
            }}
          >
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
          <label className="textarea">
            <span className="ac-text-caption ac-muted">
              Причина (обязательно, попадёт в журнал)
            </span>
            <textarea
              value={reason}
              rows={2}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {error && <p className="dialog-error">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
