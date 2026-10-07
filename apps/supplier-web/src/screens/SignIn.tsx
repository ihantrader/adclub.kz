import { isApiError } from "@adclub/api-client";
import {
  supplierSelectionRequiredDetailsSchema,
  type LoginCodeChannel,
  type SignInCompletedResponse,
  type SupplierSummary,
} from "@adclub/contracts";
import { normalizeKzMobilePhone } from "@adclub/domain";
import { Banner, Button, FadeSwap, Icon, TextField } from "@adclub/ui";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { apiClient, session } from "../api";
import { deviceName, formatPhone, type SignedOutReason, typePhone } from "@adclub/web-session";
import { loginErrorText } from "../errors";
import { useT } from "../i18n";
import { rememberedSupplier, rememberSupplier } from "../prefs";
import { AuthLayout } from "./AuthLayout";

/**
 * S-AUTH-01…03: phone → code → (several companies) the company → the
 * cabinet. No registration: a number without a membership hears so only
 * after the code is checked (the code is spent either way, D-046).
 */
type Step =
  | { kind: "phone" }
  | {
      kind: "code";
      phone: string;
      channel: LoginCodeChannel;
      requested: LoginCodeChannel | undefined;
      codeLength: number;
      resendAvailableAt: string;
    }
  | { kind: "select"; signInStep: string; suppliers: SupplierSummary[] }
  | { kind: "not_member" };

/** What both ways of finishing a sign-in answer with. */
type SignInResult = Pick<SignInCompletedResponse, "session" | "access">;

export interface SignInProps {
  reason: SignedOutReason;
  /** A sign-in finished on this page (S-INST-01 is offered once after it). */
  onSignedIn: () => void;
}

function thisDevice(): string {
  return deviceName(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

export function SignIn({ reason, onSignedIn }: SignInProps) {
  const t = useT();
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [notice, setNotice] = useState<string | null>(
    reason === "access_closed"
      ? t("auth.accessClosed")
      : reason === "session_ended"
        ? t("auth.sessionEnded")
        : null,
  );

  const finish = (response: SignInResult) => {
    if (response.access.context === "supplier") {
      rememberSupplier(response.access.supplier.id);
    }
    session.signedIn({
      sessionId: response.session.sessionId,
      accessToken: response.session.accessToken,
      accessTokenExpiresAt: response.session.accessTokenExpiresAt,
    });
    onSignedIn();
  };

  return (
    <AuthLayout>
      {/* A step takes the place of the previous one with a fade (D-069); the logo stays. */}
      <FadeSwap className="auth-step" fadeKey={step.kind}>
        {notice && step.kind === "phone" && (
          <Banner tone={reason === "access_closed" ? "warning" : "neutral"}>{notice}</Banner>
        )}
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
            onSignedIn={finish}
            onSelect={(next) => setStep(next)}
            onNotMember={() => setStep({ kind: "not_member" })}
          />
        )}
        {step.kind === "select" && (
          <SelectStep
            step={step}
            onSignedIn={finish}
            onExpired={() => {
              setNotice(t("auth.stepExpired"));
              setStep({ kind: "phone" });
            }}
            onNotMember={() => setStep({ kind: "not_member" })}
          />
        )}
        {step.kind === "not_member" && (
          <div className="auth-stack">
            <Banner tone="warning">{t("auth.notMember")}</Banner>
            <Button variant="secondary" size="l" block onClick={() => setStep({ kind: "phone" })}>
              {t("auth.otherNumber")}
            </Button>
          </div>
        )}
      </FadeSwap>
    </AuthLayout>
  );
}

function PhoneStep({ onSent }: { onSent: (step: Extract<Step, { kind: "code" }>) => void }) {
  const t = useT();
  const [raw, setRaw] = useState("+7");
  const [error, setError] = useState<string | null>(null);
  const phone = normalizeKzMobilePhone(raw);
  const digits = raw.replace(/\D/g, "").length;
  const showsInvalid = error === null && digits >= 11 && phone === null;

  const send = async (channel?: "sms") => {
    if (!phone) return;
    setError(null);
    try {
      const response = await apiClient.requestLoginCode({ phone, ...(channel ? { channel } : {}) });
      onSent({
        kind: "code",
        phone: response.phone,
        channel: response.channel,
        requested: channel,
        codeLength: response.codeLength,
        resendAvailableAt: response.resendAvailableAt,
      });
    } catch (thrown) {
      setError(loginErrorText(thrown, t));
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
      <h1 className="ac-text-title">{t("auth.title")}</h1>
      <TextField
        label={t("auth.phoneLabel")}
        value={raw}
        onChange={(value) => setRaw(typePhone(value))}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        autoFocus
        error={error ?? (showsInvalid ? t("auth.phoneInvalid") : undefined)}
        hint={!error && !showsInvalid ? t("auth.channelHint") : undefined}
      />
      <Button size="l" block disabled={!phone} onClick={() => send()}>
        {t("auth.getCode")}
      </Button>
      <Button variant="text" disabled={!phone} onClick={() => send("sms")}>
        {t("auth.noWhatsapp")}
      </Button>
      <p className="ac-text-caption ac-muted auth-note">{t("auth.policyNotice")}</p>
    </form>
  );
}

function CodeStep({
  step,
  onBack,
  onSignedIn,
  onSelect,
  onNotMember,
}: {
  step: Extract<Step, { kind: "code" }>;
  onBack: () => void;
  onSignedIn: (response: SignInResult) => void;
  onSelect: (step: Extract<Step, { kind: "select" }>) => void;
  onNotMember: () => void;
}) {
  const t = useT();
  const [channel, setChannel] = useState(step.channel);
  const [codeLength, setCodeLength] = useState(step.codeLength);
  const [resendAvailableAt, setResendAvailableAt] = useState(step.resendAvailableAt);
  const [fellBack, setFellBack] = useState(step.requested !== "sms" && step.channel === "sms");
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
      const response = await apiClient.verifyLoginCode({
        phone: step.phone,
        code: value,
        deviceName: thisDevice(),
        ...(rememberedSupplier() ? { supplierId: rememberedSupplier() } : {}),
      });
      onSignedIn(response);
    } catch (thrown) {
      setCode("");
      if (isApiError(thrown) && thrown.code === "SUPPLIER_SELECTION_REQUIRED") {
        const details = supplierSelectionRequiredDetailsSchema.safeParse(thrown.details);
        if (details.success) {
          onSelect({
            kind: "select",
            signInStep: details.data.signInStep.token,
            suppliers: details.data.suppliers,
          });
          return;
        }
      }
      if (isApiError(thrown) && thrown.code === "NOT_SUPPLIER_MEMBER") {
        onNotMember();
        return;
      }
      setError(loginErrorText(thrown, t, secondsLeft));
    } finally {
      setPending(false);
    }
  };

  const onChangeCode = (value: string) => {
    // The field stays enabled (and focused) while a code is checked; typing waits.
    if (pending) return;
    const digits = value.replace(/\D/g, "").slice(0, codeLength);
    setCode(digits);
    if (digits.length === codeLength) void verify(digits);
  };

  const resend = async (forceSms: boolean) => {
    setError(null);
    try {
      const response = await apiClient.requestLoginCode({
        phone: step.phone,
        ...(forceSms ? { channel: "sms" as const } : {}),
      });
      setChannel(response.channel);
      setCodeLength(response.codeLength);
      setResendAvailableAt(response.resendAvailableAt);
      setFellBack(!forceSms && response.channel === "sms");
      setCode("");
    } catch (thrown) {
      setError(loginErrorText(thrown, t, secondsLeft));
    }
  };

  return (
    <div className="auth-stack">
      <h1 className="ac-text-title">
        {channel === "sms" ? t("auth.codeTitleSms") : t("auth.codeTitleWhatsapp")}
      </h1>
      <div className="auth-phone-row">
        <span className="ac-muted num">{formatPhone(step.phone)}</span>
        <Button variant="text" onClick={onBack}>
          {t("auth.changeNumber")}
        </Button>
      </div>
      {fellBack && <p className="ac-text-body-s ac-muted">{t("auth.fellBackToSms")}</p>}
      <TextField
        label={t("auth.codeLabel")}
        value={code}
        onChange={onChangeCode}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={codeLength}
        autoFocus
        className="auth-code"
        aria-busy={pending || undefined}
        error={error ?? undefined}
      />
      {secondsLeft > 0 ? (
        <p className="ac-text-body-s ac-muted">{t("auth.resendIn", { seconds: secondsLeft })}</p>
      ) : (
        <Button variant="text" onClick={() => resend(false)}>
          {t("auth.resend")}
        </Button>
      )}
      {channel === "whatsapp" && (
        <Button variant="text" onClick={() => resend(true)}>
          {t("auth.sendSms")}
        </Button>
      )}
    </div>
  );
}

function SelectStep({
  step,
  onSignedIn,
  onExpired,
  onNotMember,
}: {
  step: Extract<Step, { kind: "select" }>;
  onSignedIn: (response: SignInResult) => void;
  onExpired: () => void;
  onNotMember: () => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);

  const choose = async (supplierId: string) => {
    setError(null);
    try {
      const response = await apiClient.selectSupplier({
        signInStep: step.signInStep,
        supplierId,
        deviceName: thisDevice(),
      });
      onSignedIn(response);
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "SIGN_IN_STEP_INVALID") onExpired();
      else if (isApiError(thrown) && thrown.code === "NOT_SUPPLIER_MEMBER") onNotMember();
      else setError(loginErrorText(thrown, t));
    }
  };

  return (
    <div className="auth-stack">
      <h1 className="ac-text-title">{t("auth.selectTitle")}</h1>
      <p className="ac-text-body-s ac-muted">{t("auth.selectHint")}</p>
      {error && <Banner tone="danger">{error}</Banner>}
      <ul className="choice-list">
        {step.suppliers.map((supplier) => (
          <li key={supplier.id}>
            <ChoiceButton onClick={() => choose(supplier.id)}>
              <span className="choice-list__text">
                <span className="ac-text-body-strong">{supplier.name}</span>
                <span className="ac-text-body-s ac-muted">{supplier.city}</span>
              </span>
              <Icon name="chevronRight" size={20} />
            </ChoiceButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A full-width row that shows its own progress (SCREENS 2.1). */
export function ChoiceButton({
  onClick,
  children,
  current = false,
}: {
  onClick: () => Promise<unknown> | unknown;
  children: ReactNode;
  current?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="choice-list__item"
      aria-busy={busy || undefined}
      aria-current={current || undefined}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}
