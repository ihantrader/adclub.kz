import type { SessionSummary } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, DataState, Dialog, ListRow, Screen, useToast } from "../../design-system";
import type { ProfileStackParams } from "../../navigation/routes";
import { apiClient } from "../../services/api";
import { useT, type LanguageContextValue } from "../../state/language";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A plain, locale-independent "27.09.2026 14:05" — no dependence on the device's ICU data. */
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function deviceTitle(session: SessionSummary, t: LanguageContextValue["t"]): string {
  if (session.deviceName) return session.deviceName;
  switch (session.platform) {
    case "ios":
      return "iPhone / iPad";
    case "android":
      return "Android";
    case "supplier-web":
      return t("profile.supplierCabinet");
    case "admin-web":
      return t("profile.adminPanel");
    default:
      return t("profile.unknownDevice");
  }
}

/** M-PRO-03 «Устройства»: every session, "Это устройство", end one or all others (T-PRO-02). */
export function DevicesScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParams, "profile-devices">) {
  const t = useT();
  const { show } = useToast();
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

  return (
    <Screen
      title={t("profile.devices")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
    >
      <DataState
        status={status}
        skeleton={null}
        error={{
          title: t("state.errorTitle"),
          text: t("state.errorText"),
          retry: { label: t("common.retry"), onRetry: load },
        }}
        empty={{ icon: "devices", title: t("state.errorTitle") }}
      >
        <View style={styles.content}>
          <View style={styles.rows}>
            {sessions?.map((session, index) => (
              <ListRow
                key={session.id}
                first={index === 0}
                icon="devices"
                title={deviceTitle(session, t)}
                subtitle={
                  session.current ? t("profile.thisDevice") : formatDateTime(session.lastUsedAt)
                }
                trailing={
                  session.current ? undefined : (
                    <Button variant="text" size="m" onPress={() => setEndingId(session.id)}>
                      {t("profile.endSession")}
                    </Button>
                  )
                }
              />
            ))}
          </View>
          {sessions && sessions.length > 1 && (
            <Button variant="secondary" destructive onPress={() => setConfirmEndOthers(true)}>
              {t("profile.endOthers")}
            </Button>
          )}
        </View>
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

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 8, gap: 16 },
  rows: { borderRadius: layout.cardPadding, overflow: "hidden" },
});
