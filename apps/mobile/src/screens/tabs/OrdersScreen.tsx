import { layout } from "@adclub/ui-core";
import { StyleSheet, View } from "react-native";
import { Button, DataState, OfflineBanner, Screen } from "../../design-system";
import { useSignIn } from "../../navigation/use-sign-in";
import { useOnline } from "../../services/use-network";
import { useT } from "../../state/language";
import { useSession } from "../../state/session-provider";

/**
 * M-ORD-02 as a shell (TASK-030 fills it). A guest has no orders at all, so
 * the tab shows the empty state of SCREENS 5.1 ("Здесь будут ваши заявки и
 * коды для получения") with "Войти" straight to M-AUTH-01 — SCREENS is
 * explicit that this tab is "не шторка" (unlike M-AUTH-00 elsewhere).
 * Without a network the saved copy would open here — there is none to save
 * yet (TASK-030), so the "Нет сети" state is what is shown.
 */
export function OrdersScreen() {
  const t = useT();
  const online = useOnline();
  const session = useSession();
  const signIn = useSignIn();

  return (
    <Screen
      title={t("tabs.orders")}
      root
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
    >
      <View style={styles.content}>
        <DataState
          status={online ? "empty" : "offline"}
          skeleton={null}
          error={{ title: t("state.errorTitle"), text: t("state.errorText") }}
          offline={{ title: t("state.offline"), text: t("state.offlineText") }}
          empty={{
            icon: "receipt",
            title: t("orders.guestEmptyTitle"),
            action:
              session.status === "guest" ? (
                <Button onPress={signIn.start}>{t("auth.signIn")}</Button>
              ) : undefined,
          }}
        >
          {null}
        </DataState>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12 },
});
