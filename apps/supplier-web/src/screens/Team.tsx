import { isApiError } from "@adclub/api-client";
import {
  supplierMemberExistsDetailsSchema,
  type NotificationLanguage,
  type SupplierMember,
  type SupplierMemberListResponse,
  type SupplierNotificationSummary,
} from "@adclub/contracts";
import { normalizeKzMobilePhone } from "@adclub/domain";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  LoadingContent,
  ScreenError,
  Segments,
  SkeletonList,
  Switch,
  TextField,
  useLoadingGate,
  useToast,
} from "@adclub/ui";
import { useCallback, useEffect, useState } from "react";
import { apiClient, session } from "../api";
import { clearCabinet } from "../cabinet/cabinet-store";
import { formatPhone, typePhone, useOnline } from "@adclub/web-session";
import { rateLimitName, retryMinutes, saveErrorText } from "../errors";
import { useT, type Translate } from "../i18n";
import { forgetPerson } from "../prefs";

/**
 * Under a notification switch: why it can't be turned on (the limit is
 * full) or why it is on and still nobody writes (the limit was lowered and
 * the first ones keep it) — SCREENS S-TEAM-01.
 */
export function notificationNote(
  member: Pick<SupplierMember, "notificationsEnabled" | "receivesNotifications">,
  summary: SupplierNotificationSummary,
  t: Translate,
): string | null {
  if (member.notificationsEnabled && !member.receivesNotifications) {
    return t("team.waiting", { n: summary.limit });
  }
  if (!member.notificationsEnabled && summary.full) {
    return t("team.limitReached", { n: summary.limit });
  }
  return null;
}

/** What the server's refusal of a new colleague means for the person adding them. */
function addErrorText(error: unknown, t: Translate): { field?: "phone"; text: string } {
  if (isApiError(error) && error.code === "SUPPLIER_MEMBER_EXISTS") {
    const details = supplierMemberExistsDetailsSchema.safeParse(error.details);
    return {
      field: "phone",
      text:
        details.success && details.data.status === "removed"
          ? t("team.removedBefore")
          : t("team.exists"),
    };
  }
  if (isApiError(error) && error.code === "RATE_LIMITED") {
    if (rateLimitName(error) === "supplier_members_added_per_supplier") {
      return { text: t("team.addLimit", { hours: Math.ceil(retryMinutes(error) / 60) }) };
    }
  }
  if (isApiError(error) && error.code === "VALIDATION_ERROR") {
    return { field: "phone", text: t("auth.phoneInvalid") };
  }
  return { text: saveErrorText(error, t) };
}

/** S-TEAM-01 «Сотрудники»: every employee is equal — anyone sees and does all of this. */
export function Team() {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const [list, setList] = useState<SupplierMemberListResponse | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SupplierMember | null>(null);
  const gate = useLoadingGate();
  const { begin, settle } = gate;

  // No state is set before the answer: the effect below only starts the
  // request. The answer comes through the loading rule (D-069): the list on
  // screen stays until the next one, a skeleton only for the first.
  const load = useCallback(async () => {
    const ticket = begin();
    try {
      const next = await apiClient.listSupplierMembers();
      settle(ticket, () => {
        setList(next);
        setLoadError(null);
      });
    } catch (thrown) {
      settle(ticket, () => setLoadError(thrown));
    }
  }, [begin, settle]);

  useEffect(() => {
    // Loading on mount, as DevicesScreen of the app does.
    void load();
  }, [load]);

  const update = async (
    member: SupplierMember,
    body: { notificationsEnabled?: boolean; notificationLanguage?: NotificationLanguage },
  ) => {
    setError(null);
    try {
      const next = await apiClient.updateSupplierMember({ memberId: member.id }, body);
      setList((current) =>
        current
          ? {
              members: current.members.map((item) =>
                item.id === next.member.id ? next.member : item,
              ),
              notifications: next.notifications,
            }
          : current,
      );
      // Turning one switch changes who else is within the limit.
      if (body.notificationsEnabled !== undefined) void load();
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "SUPPLIER_NOTIFICATION_LIMIT") {
        setError(t("team.limitReached", { n: list?.notifications.limit ?? "" }));
        void load();
      } else if (isApiError(thrown) && thrown.code === "NOT_FOUND") {
        setError(t("team.gone"));
        void load();
      } else {
        setError(saveErrorText(thrown, t));
      }
    }
  };

  const remove = async (member: SupplierMember) => {
    setError(null);
    try {
      const result = await apiClient.removeSupplierMember({ memberId: member.id });
      setRemoving(null);
      if (result.self) {
        // This session ended with the membership: back to the sign-in.
        forgetPerson();
        clearCabinet();
        session.signOut("none");
        return;
      }
      toast.show(t("team.removed"));
      void load();
    } catch (thrown) {
      setRemoving(null);
      if (isApiError(thrown) && thrown.code === "SUPPLIER_LAST_MEMBER") {
        setError(t("team.lastMember"));
      } else if (isApiError(thrown) && thrown.code === "NOT_FOUND") {
        setError(t("team.gone"));
        void load();
      } else {
        setError(saveErrorText(thrown, t));
      }
    }
  };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title page__title">{t("team.title")}</h1>
        {!adding && (
          <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>
            {t("team.add")}
          </Button>
        )}
      </div>
      {list && (
        <p className="ac-text-body-s ac-muted">
          {t("team.explanation", { n: list.notifications.limit })}
        </p>
      )}
      {adding && (
        <AddMember
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            toast.show(t("team.invited"));
            void load();
          }}
        />
      )}
      {error && <Banner tone="danger">{error}</Banner>}

      {loadError !== null && !list ? (
        <ScreenError
          title={t("common.errorTitle")}
          text={t("common.errorText")}
          retry={{ label: t("common.retry"), onRetry: load }}
        />
      ) : (
        <LoadingContent
          ready={list !== null}
          indicator={gate.indicator}
          skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
          label={t("common.loading")}
          // Switches over a list about to be replaced would act on what is gone.
          lock
          notice={
            loadError !== null && (
              <Banner
                tone="danger"
                action={
                  <Button variant="text" size="s" icon="refresh" onClick={load}>
                    {t("common.retry")}
                  </Button>
                }
              >
                {t("common.errorText")}
              </Banner>
            )
          }
        >
          {list && (
            <ul className="member-list">
              {list.members.map((member) => (
                <li key={member.id} className="card member">
                  <div className="member__head">
                    <span className="ac-text-body-strong member__name">{member.displayName}</span>
                    <a className="member__phone num" href={`tel:${member.phone}`}>
                      {formatPhone(member.phone)}
                    </a>
                    <span className="member__badges">
                      {member.isMe && (
                        <Badge tone="accent" icon="user">
                          {t("team.me")}
                        </Badge>
                      )}
                      {member.isContactPerson && (
                        <Badge tone="neutral" icon="phone">
                          {t("team.contactPerson")}
                        </Badge>
                      )}
                    </span>
                  </div>
                  <Switch
                    label={t("team.receives")}
                    description={notificationNote(member, list.notifications, t) ?? undefined}
                    checked={member.notificationsEnabled}
                    disabled={!online || (!member.notificationsEnabled && list.notifications.full)}
                    onChange={(checked) => update(member, { notificationsEnabled: checked })}
                  />
                  <div className="field-block">
                    <span className="field-block__label">{t("team.notificationLanguage")}</span>
                    <Segments<NotificationLanguage>
                      label={`${t("team.notificationLanguage")}: ${member.displayName}`}
                      value={member.notificationLanguage}
                      onChange={(value) => {
                        if (online) void update(member, { notificationLanguage: value });
                      }}
                      options={[
                        { value: "kk", label: t("language.kk") },
                        { value: "ru", label: t("language.ru") },
                      ]}
                    />
                  </div>
                  <div className="member__actions">
                    <Button
                      variant="secondary"
                      destructive
                      icon="trash"
                      disabled={!online}
                      onClick={() => setRemoving(member)}
                    >
                      {t("team.remove")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </LoadingContent>
      )}

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing?.isMe ? t("team.removeSelfTitle") : t("team.removeTitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={!online}
              onClick={() => (removing ? remove(removing) : undefined)}
            >
              {t("team.remove")}
            </Button>
          </>
        }
      >
        {removing &&
          (removing.isMe
            ? t("team.removeSelfText")
            : t("team.removeText", { name: removing.displayName }))}
      </Dialog>
    </>
  );
}

function AddMember({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const t = useT();
  const online = useOnline();
  const [name, setName] = useState("");
  const [rawPhone, setRawPhone] = useState("+7");
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const phone = normalizeKzMobilePhone(rawPhone);
  const digits = rawPhone.replace(/\D/g, "").length;
  const phoneInvalid = digits >= 11 && phone === null;

  const submit = async () => {
    setError(null);
    setPhoneError(null);
    if (name.trim().length === 0) {
      setNameError(t("team.nameRequired"));
      return;
    }
    if (!phone) {
      setPhoneError(t("auth.phoneInvalid"));
      return;
    }
    try {
      await apiClient.addSupplierMember({ name: name.trim(), phone });
      onAdded();
    } catch (thrown) {
      const problem = addErrorText(thrown, t);
      if (problem.field === "phone") setPhoneError(problem.text);
      else setError(problem.text);
    }
  };

  return (
    <section className="card stack-m" aria-label={t("team.addTitle")}>
      <h2 className="ac-text-heading">{t("team.addTitle")}</h2>
      <p className="ac-text-body-s ac-muted">{t("team.addHint")}</p>
      <TextField
        label={t("team.nameLabel")}
        value={name}
        onChange={(value) => {
          setName(value);
          setNameError(null);
        }}
        autoComplete="off"
        maxLength={100}
        error={nameError ?? undefined}
      />
      <TextField
        label={t("auth.phoneLabel")}
        value={rawPhone}
        onChange={(value) => {
          setRawPhone(typePhone(value));
          setPhoneError(null);
        }}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        error={phoneError ?? (phoneInvalid ? t("auth.phoneInvalid") : undefined)}
      />
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="actions-row">
        <Button disabled={!online || !phone || name.trim().length === 0} onClick={submit}>
          {t("common.add")}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
      {!online && <p className="ac-text-caption ac-muted">{t("common.needNetwork")}</p>}
    </section>
  );
}
