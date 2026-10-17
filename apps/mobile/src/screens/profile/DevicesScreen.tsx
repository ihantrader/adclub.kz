import type { SessionSummary } from "@adclub/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  DataState,
  Dialog,
  ListGroup,
  ListRow,
  Screen,
  ScreenBody,
  Section,
  SkeletonList,
  useToast,
} from "../../design-system";
import type { ProfileStackParams } from "../../navigation/routes";
import { useLeaveWhenSignedOut } from "../../navigation/use-leave-when-signed-out";
import { apiClient } from "../../services/api";
import { useT, type LanguageContextValue } from "../../state/language";
import { useNow, useOrderTime } from "../orders/parts";

function deviceTitle(session: SessionSummary, t: LanguageContextValue["t"]): string {
  if (session.deviceName) return session.deviceName;
  switch (session.platform) {
    case "ios":
      return t("profile.platformIos");
    case "android":
      return t("profile.platformAndroid");
    case "supplier-web":
      return t("profile.supplierCabinet");
    case "admin-web":
      return t("profile.adminPanel");
    default:
      return t("profile.unknownDevice");
  }
}

/**
 * M-PRO-03 «Устройства»: every session, in two groups — «Это устройство» and
 * «Другие устройства» (TASK-078); the last activity in the one way of
 * writing a moment (M15); «Завершить» on every other session is a row action
 * of the `text` colour (M16), the danger is kept for «Завершить на всех
 * других» (T-PRO-02).
 */
export function DevicesScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParams, "profile-devices">) {
  const t = useT();
  const { show } = useToast();
  const now = useNow();
  const time = useOrderTime();
  useLeaveWhenSignedOut(navigation);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [confirmEndOthers, setConfirmEndOthers] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const response = await apiClient.listSessions();
      setSessions(response.sessions);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // Loading the list on mount, not deriving it from a prop: the rule's own
    // exception ("subscribe for updates from some external system") is this.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const endOne = async (id: string) => {
    setEndingId(null);
    try {
      await apiClient.endSession({ sessionId: id });
      await load();
    } catch {
      show(t("state.errorText"));
    }
  };

  const endOthers = async () => {
    setConfirmEndOthers(false);
    try {
      const result = await apiClient.endOtherSessions();
      show(t("profile.endedOthers", { n: String(result.ended) }));
      await load();
    } catch {
      show(t("state.errorText"));
    }
  };

  const status = sessions ? "ready" : failed ? "error" : "loading";
  const endingSession = sessions?.find((session) => session.id === endingId) ?? null;
  const current = sessions?.filter((session) => session.current) ?? [];
  const others = sessions?.filter((session) => !session.current) ?? [];

  return (
    <Screen
      title={t("profile.devices")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
        error={{
          title: t("state.errorTitle"),
          text: t("state.errorText"),
          retry: { label: t("common.retry"), onRetry: load },
        }}
        empty={{ icon: "devices", title: t("state.errorTitle") }}
      >
        <ScreenBody>
          {current.length > 0 && (
            <Section first title={t("profile.thisDevice")}>
              <ListGroup>
                {current.map((session, index) => (
                  <ListRow
                    key={session.id}
                    first={index === 0}
                    icon="devices"
                    title={deviceTitle(session, t)}
                    subtitle={time.when(session.lastUsedAt, null, now)}
                  />
                ))}
              </ListGroup>
            </Section>
          )}
          {others.length > 0 && (
            <Section first={current.length === 0} title={t("profile.otherDevices")}>
              <ListGroup>
                {others.map((session, index) => (
                  <ListRow
                    key={session.id}
                    first={index === 0}
                    icon="devices"
                    title={deviceTitle(session, t)}
                    subtitle={time.when(session.lastUsedAt, null, now)}
                    trailing={
                      <Button
                        variant="text"
                        tone="neutral"
                        size="m"
                        onPress={() => setEndingId(session.id)}
                      >
                        {t("profile.endSession")}
                      </Button>
                    }
                  />
                ))}
              </ListGroup>
              <Button variant="secondary" destructive onPress={() => setConfirmEndOthers(true)}>
                {t("profile.endOthers")}
              </Button>
            </Section>
          )}
        </ScreenBody>
      </DataState>

      <Dialog
        visible={endingSession !== null}
        onClose={() => setEndingId(null)}
        title={t("profile.endSessionConfirmTitle")}
        actions={
          <>
            <Button
              variant="secondary"
              destructive
              onPress={() => endingId && void endOne(endingId)}
            >
              {t("profile.endSession")}
            </Button>
            <Button variant="text" onPress={() => setEndingId(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {t("profile.endSessionConfirmText")}
      </Dialog>

      <Dialog
        visible={confirmEndOthers}
        onClose={() => setConfirmEndOthers(false)}
        title={t("profile.endOthersConfirmTitle")}
        actions={
          <>
            <Button variant="secondary" destructive onPress={() => void endOthers()}>
              {t("profile.endOthers")}
            </Button>
            <Button variant="text" onPress={() => setConfirmEndOthers(false)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {t("profile.endOthersConfirmText")}
      </Dialog>
    </Screen>
  );
}
