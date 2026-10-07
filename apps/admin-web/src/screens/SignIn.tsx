import { isApiError } from "@adclub/api-client";
import {
  totpStepRequiredDetailsSchema,
  type LoginCodeChannel,
  type SignInCompletedResponse,
  type TotpSetupResponse,
} from "@adclub/contracts";
import { normalizeKzMobilePhone } from "@adclub/domain";
import { Banner, Button, FadeSwap, QrCode, Spinner, TextField } from "@adclub/ui";
import { deviceName, formatPhone, typePhone, type SignedOutReason } from "@adclub/web-session";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiClient, session } from "../api";
import { signInErrorText } from "../errors";
import { setBackupCodesRemaining } from "../security/backup-reminder";
import { AuthLayout } from "./AuthLayout";
import { BackupCodes } from "./BackupCodes";

/**
 * A-AUTH (SCREENS 7.1; TASK-034 requirement 2): phone → code → the second
 * factor. The first sign-in (or the first after a reset) sets the
 * authenticator app up: the QR is drawn on this page from `otpauthUri`
 * (`QrCode`, no outside service), the secret is beside it for typing in,
 * then a check code, then the backup codes — once. The admin panel opens
 * only after «Я сохранил коды». Every step goes with the cookies of the API
 * (the step lives in the server's cookie, 4.9 I80). The secret, the codes
 * and the tokens live only in this component's memory.
 */
type Step =
  | { kind: "phone" }
  | {
      kind: "code";
      phone: string;
      channel: LoginCodeChannel;
      codeLength: number;
      resendAvailableAt: string;
    }
  | { kind: "setup"; signInStep: string }
  | { kind: "totp"; signInStep: string }
  | { kind: "codes"; codes: string[]; done: SignInCompletedResponse };

const STEP_NOTICE: Record<SignedOutReason, string | null> = {
  none: null,
  session_ended:
    "Вы вышли из админки на этом устройстве: сессия завершилась (12 часов с входа, сброс второго фактора или выход на другом устройстве)",
  access_closed: "Доступ к админке закрыт",
};

function thisDevice(): string {
  return deviceName(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

/** The step token of `TOTP_SETUP_REQUIRED` / `TOTP_REQUIRED`. */
function stepOf(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const parsed = totpStepRequiredDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data.signInStep.token : null;
}

export function SignIn({ reason }: { reason: SignedOutReason }) {
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [notice, setNotice] = useState<string | null>(STEP_NOTICE[reason]);

  const finish = (response: SignInCompletedResponse) => {
    session.signedIn({
      sessionId: response.session.sessionId,
      accessToken: response.session.accessToken,
      accessTokenExpiresAt: response.session.accessTokenExpiresAt,
    });
  };

  const restart = (text: string) => {
    setNotice(text);
    setStep({ kind: "phone" });
  };

  return (
    <AuthLayout wide={step.kind === "setup" || step.kind === "codes"}>
      {/* A step takes the place of the previous one with a fade (D-069); the logo stays. */}
      <FadeSwap className="auth-step" fadeKey={step.kind}>
        {notice && step.kind === "phone" && <Banner>{notice}</Banner>}
        {step.kind === "phone" && (
          <PhoneStep
            onSent={(next) => {
              setNotice(null);
              setStep(next);
            }}
          />
        )}
        {step.kind === "code" && (
          <CodeStep
            step={step}
            onBack={() => setStep({ kind: "phone" })}
            onSecondFactor={setStep}
          />
        )}
        {step.kind === "setup" && (
          <SetupStep
            signInStep={step.signInStep}
            onExpired={() => restart("Время на вход истекло. Начните вход заново")}
            onConfirmed={(codes, done) => setStep({ kind: "codes", codes, done })}
          />
        )}
        {step.kind === "totp" && (
          <TotpStep
            signInStep={step.signInStep}
            onExpired={() => restart("Время на вход истекло. Начните вход заново")}
            onSignedIn={(done, remaining) => {
              setBackupCodesRemaining(remaining);
              finish(done);
            }}
          />
        )}
        {step.kind === "codes" && (
          <BackupCodes
            codes={step.codes}
            onDone={() => {
              setBackupCodesRemaining(null);
              finish(step.done);
            }}
          />
        )}
      </FadeSwap>
    </AuthLayout>
  );
}

function PhoneStep({ onSent }: { onSent: (step: Extract<Step, { kind: "code" }>) => void }) {
  const [raw, setRaw] = useState("+7");
  const [error, setError] = useState<string | null>(null);
  const phone = normalizeKzMobilePhone(raw);
  const digits = raw.replace(/\D/g, "").length;
  const showsInvalid = error === null && digits >= 11 && phone === null;

  const send = async () => {
    if (!phone) return;
    setError(null);
    try {
      const response = await apiClient.requestLoginCode({ phone });
      onSent({
        kind: "code",
        phone: response.phone,
        channel: response.channel,
        codeLength: response.codeLength,
        resendAvailableAt: response.resendAvailableAt,
      });
    } catch (thrown) {
      setError(signInErrorText(thrown));
    }
  };

  return (
    <form
      className="auth-stack"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void send();
      }}
    >
      <h1 className="ac-text-title">Вход в админку</h1>
      <TextField
        label="Номер телефона"
        value={raw}
        onChange={(value) => setRaw(typePhone(value))}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        autoFocus
        error={error ?? (showsInvalid ? "Проверьте номер: +7 и десять цифр" : undefined)}
        hint={!error && !showsInvalid ? "Код придёт в WhatsApp" : undefined}
      />
      <Button size="l" block disabled={!phone} onClick={send}>
        Получить код
      </Button>
    </form>
  );
}

function CodeStep({
  step,
  onBack,
  onSecondFactor,
}: {
  step: Extract<Step, { kind: "code" }>;
  onBack: () => void;
  onSecondFactor: (next: Step) => void;
}) {
  const [channel, setChannel] = useState(step.channel);
  const [resendAvailableAt, setResendAvailableAt] = useState(step.resendAvailableAt);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((Date.parse(resendAvailableAt) - now) / 1000));

  const verify = async (value: string) => {
    setError(null);
    setPending(true);
    try {
      // An administrator never gets a session from the code alone.
      await apiClient.verifyLoginCode({ phone: step.phone, code: value, deviceName: thisDevice() });
      setError("Что-то пошло не так. Начните вход заново");
    } catch (thrown) {
      setCode("");
      const signInStep = stepOf(thrown);
      if (isApiError(thrown) && thrown.code === "TOTP_SETUP_REQUIRED" && signInStep) {
        onSecondFactor({ kind: "setup", signInStep });
        return;
      }
      if (isApiError(thrown) && thrown.code === "TOTP_REQUIRED" && signInStep) {
        onSecondFactor({ kind: "totp", signInStep });
        return;
      }
      setError(signInErrorText(thrown));
    } finally {
      setPending(false);
    }
  };

  const resend = async () => {
    setError(null);
    try {
      const response = await apiClient.requestLoginCode({ phone: step.phone });
      setChannel(response.channel);
      setResendAvailableAt(response.resendAvailableAt);
      setCode("");
    } catch (thrown) {
      setError(signInErrorText(thrown));
    }
  };

  return (
    <div className="auth-stack">
      <h1 className="ac-text-title">
        {channel === "sms" ? "Введите код из SMS" : "Введите код из WhatsApp"}
      </h1>
      <div className="auth-phone-row">
        <span className="ac-muted num">{formatPhone(step.phone)}</span>
        <Button variant="text" onClick={onBack}>
          Изменить номер
        </Button>
      </div>
      <TextField
        label="Код"
        value={code}
        onChange={(value) => {
          if (pending) return;
          const digits = value.replace(/\D/g, "").slice(0, step.codeLength);
          setCode(digits);
          if (digits.length === step.codeLength) void verify(digits);
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={step.codeLength}
        autoFocus
        className="auth-code"
        aria-busy={pending || undefined}
        error={error ?? undefined}
      />
      {secondsLeft > 0 ? (
        <p className="ac-text-body-s ac-muted">Новый код можно запросить через {secondsLeft} с</p>
      ) : (
        <Button variant="text" onClick={resend}>
          Отправить код ещё раз
        </Button>
      )}
    </div>
  );
}

/** The secret in groups of four, as authenticator apps print it. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

function SetupStep({
  signInStep,
  onExpired,
  onConfirmed,
}: {
  signInStep: string;
  onExpired: () => void;
  onConfirmed: (codes: string[], done: SignInCompletedResponse) => void;
}) {
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const expired = useRef(onExpired);
  useEffect(() => {
    expired.current = onExpired;
  });

  useEffect(() => {
    let cancelled = false;
    // Asking again within the same step returns the same secret.
    apiClient.startTotpSetup({ signInStep }).then(
      (response) => {
        if (!cancelled) {
          setLoadError(null);
          setSetup(response);
        }
      },
      (thrown: unknown) => {
        if (cancelled) return;
        if (isApiError(thrown) && thrown.code === "SIGN_IN_STEP_INVALID") expired.current();
        else setLoadError(signInErrorText(thrown));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [signInStep, attempt]);

  const confirm = async (value: string) => {
    setError(null);
    setPending(true);
    try {
      const response = await apiClient.confirmTotpSetup({
        signInStep,
        totpCode: value,
        deviceName: thisDevice(),
      });
      onConfirmed(response.backupCodes, response);
    } catch (thrown) {
      setCode("");
      if (isApiError(thrown) && thrown.code === "SIGN_IN_STEP_INVALID") onExpired();
      else setError(signInErrorText(thrown));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="auth-stack">
      <h1 className="ac-text-title">Настройка второго фактора</h1>
      <p className="ac-text-body-s ac-muted">
        Откройте приложение-аутентификатор на телефоне (Google Authenticator, Microsoft
        Authenticator или другое), добавьте аккаунт и отсканируйте QR-код. Или введите ключ вручную.
      </p>
      {loadError && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </Button>
          }
        >
          {loadError}
        </Banner>
      )}
      <div className="totp-setup">
        <div className="totp-setup__qr">
          {setup ? (
            <QrCode
              value={setup.otpauthUri}
              size={200}
              label="QR-код для приложения-аутентификатора"
            />
          ) : (
            !loadError && <Spinner />
          )}
        </div>
        <dl className="totp-setup__manual">
          <dt className="ac-text-caption ac-muted">Ключ для ручного ввода</dt>
          <dd className="totp-setup__secret num">{setup ? grouped(setup.secret) : "…"}</dd>
          <dt className="ac-text-caption ac-muted">Аккаунт</dt>
          <dd className="ac-text-body-s">
            {setup ? `${setup.issuer} · ${setup.accountName}` : "…"}
          </dd>
          <dt className="ac-text-caption ac-muted">Тип</dt>
          <dd className="ac-text-body-s">По времени, 6 цифр, 30 секунд</dd>
        </dl>
      </div>
      <TextField
        label="Код из приложения"
        value={code}
        onChange={(value) => {
          if (pending) return;
          const digits = value.replace(/\D/g, "").slice(0, 6);
          setCode(digits);
          if (digits.length === 6) void confirm(digits);
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        disabled={!setup}
        className="auth-code"
        aria-busy={pending || undefined}
        error={error ?? undefined}
        hint={error ? undefined : "Введите шесть цифр, которые показывает приложение"}
      />
    </div>
  );
}

function TotpStep({
  signInStep,
  onExpired,
  onSignedIn,
}: {
  signInStep: string;
  onExpired: () => void;
  onSignedIn: (done: SignInCompletedResponse, remaining: number) => void;
}) {
  const [backup, setBackup] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const verify = async (typed: string) => {
    setError(null);
    setPending(true);
    try {
      const response = await apiClient.verifyTotp({
        signInStep,
        ...(backup ? { backupCode: typed } : { totpCode: typed }),
        deviceName: thisDevice(),
      });
      onSignedIn(response, response.backupCodesRemaining);
    } catch (thrown) {
      setValue("");
      if (isApiError(thrown) && thrown.code === "SIGN_IN_STEP_INVALID") onExpired();
      else if (isApiError(thrown) && thrown.code === "TOTP_INVALID" && backup) {
        setError("Этот резервный код не подходит или уже использован");
      } else setError(signInErrorText(thrown));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="auth-stack"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (backup && value.trim()) void verify(value.trim());
      }}
    >
      <h1 className="ac-text-title">{backup ? "Резервный код" : "Код из приложения"}</h1>
      <p className="ac-text-body-s ac-muted">
        {backup
          ? "Введите один из резервных кодов, сохранённых при настройке. Каждый код действует один раз."
          : "Откройте приложение-аутентификатор и введите шесть цифр для Asia Drive Club."}
      </p>
      {backup ? (
        <TextField
          key="backup"
          label="Резервный код"
          value={value}
          onChange={(typed) => setValue(typed.slice(0, 32))}
          autoComplete="off"
          autoFocus
          aria-busy={pending || undefined}
          error={error ?? undefined}
          hint={error ? undefined : "Например, abcd-efgh"}
        />
      ) : (
        <TextField
          key="totp"
          label="Код"
          value={value}
          onChange={(typed) => {
            if (pending) return;
            const digits = typed.replace(/\D/g, "").slice(0, 6);
            setValue(digits);
            if (digits.length === 6) void verify(digits);
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          className="auth-code"
          aria-busy={pending || undefined}
          error={error ?? undefined}
        />
      )}
      {backup && (
        <Button size="l" block type="submit" disabled={!value.trim()} loading={pending}>
          Войти
        </Button>
      )}
      <Button
        variant="text"
        onClick={() => {
          setBackup(!backup);
          setValue("");
          setError(null);
        }}
      >
        {backup ? "Войти кодом из приложения" : "Войти резервным кодом"}
      </Button>
    </form>
  );
}
