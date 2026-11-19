import type { AccountDeletionPreview } from "@adclub/contracts";
import { isApiError } from "@adclub/api-client";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
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
  Text,
  useToast,
} from "../../design-system";
import type { ProfileStackParams } from "../../navigation/routes";
import { useLeaveWhenSignedOut } from "../../navigation/use-leave-when-signed-out";
import { deletionRefusal, deletionStoreName, refusalOfError } from "../../profile/account-deletion";
import { getAccountDeletion } from "../../services/account-api";
import { useOnline } from "../../services/use-network";
import { useLanguage, useT } from "../../state/language";
import { useSession } from "../../state/session-provider";

/**
 * M-PRO-05 «Удаление аккаунта» (TASK-072, D-036, D-077; PRODUCT 6.8): the
 * first screen says what goes (the profile, the garage with its VINs and
 * plates, the history of orders; reviews stay without the name), T-PRO-05
 * with the number of active orders the server counted, that some data is
 * kept as the law requires, T-PRO-04 with the store; «Продолжить» opens the
 * second step «Удалить аккаунт навсегда?». The last employee of a company
 * and an administrator see why it cannot be done, and no «Продолжить».
 * Without the network «Удалить» is off with «Нужна сеть».
 */
export function DeleteAccountScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParams, "profile-delete">) {
  const t = useT();
  const { tn } = useLanguage();
  const { show } = useToast();
  const online = useOnline();
  const session = useSession();
  useLeaveWhenSignedOut(navigation);
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refusedNow, setRefusedNow] = useState<ReturnType<typeof refusalOfError>>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setPreview(await getAccountDeletion());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // Loading on mount: the rule's own exception (an external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const remove = async () => {
    setDeleting(true);
    try {
      await session.deleteAccount();
      setConfirm(false);
      // `useLeaveWhenSignedOut` takes the screen away with the session.
    } catch (error) {
      setDeleting(false);
      setConfirm(false);
      const refusal =
        isApiError(error) && error.code === "ACCOUNT_DELETION_REFUSED"
          ? refusalOfError(error.details)
          : null;
      if (refusal) {
        setRefusedNow(refusal);
        void load();
      } else {
        show(t(online ? "deleteAccount.failed" : "deleteAccount.needsNetwork"));
      }
    }
  };

  const refusal = refusedNow ?? deletionRefusal(preview);
  const store = deletionStoreName(preview, Platform.OS);
  const status = preview ? "ready" : failed ? "error" : "loading";

  return (
    <Screen
      title={t("deleteAccount.title")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
    >
      <DataState
        status={status}
        skeleton={<SkeletonList rows={4} label={t("common.loading")} />}
        error={{
          title: t("deleteAccount.loadFailed"),
          text: online ? t("state.errorText") : t("deleteAccount.needsNetwork"),
          retry: { label: t("common.retry"), onRetry: load },
        }}
        empty={{ icon: "trash", title: t("deleteAccount.loadFailed") }}
      >
        <ScreenBody>
          <Section first title={t("deleteAccount.whatTitle")}>
            <ListGroup>
              <ListRow first icon="user" title={t("deleteAccount.itemProfile")} />
              <ListRow icon="car" title={t("deleteAccount.itemGarage")} />
              <ListRow icon="receipt" title={t("deleteAccount.itemOrders")} />
              <ListRow icon="star" title={t("deleteAccount.itemReviews")} />
            </ListGroup>
          </Section>
          <Section>
            <View style={styles.notes}>
              {preview && preview.activeOrders > 0 && (
                <Text variant="body" testID="delete-active-orders">
                  {tn("deleteAccount.activeOrders", preview.activeOrders)}
                </Text>
              )}
              {preview && preview.supplierMemberships.length > 0 && !refusal && (
                <Text variant="body">
                  {t("deleteAccount.companies", {
                    companies: preview.supplierMemberships
                      .map((member) => `«${member.supplierName}»`)
                      .join(", "),
                  })}
                </Text>
              )}
              <Text variant="body" color="textMuted">
                {t("deleteAccount.law")}
              </Text>
              <Text variant="body" color="textMuted">
                {t("deleteAccount.store", { store })}
              </Text>
            </View>
          </Section>
          <Section>
            {refusal ? (
              <Text variant="body" color="danger" testID="delete-refused">
                {t(refusal.key, refusal.company ? { company: refusal.company } : undefined)}
              </Text>
            ) : (
              <View style={styles.actions}>
                <Button variant="danger" disabled={!online} onPress={() => setConfirm(true)}>
                  {t("deleteAccount.continue")}
                </Button>
                {!online && (
                  <Text variant="caption" color="textMuted">
                    {t("deleteAccount.needsNetwork")}
                  </Text>
                )}
              </View>
            )}
          </Section>
        </ScreenBody>
      </DataState>

      <Dialog
        visible={confirm}
        onClose={() => (deleting ? undefined : setConfirm(false))}
        title={t("deleteAccount.confirmTitle")}
        actions={
          <>
            <Button variant="danger" loading={deleting} disabled={!online} onPress={() => remove()}>
              {t("deleteAccount.confirm")}
            </Button>
            <Button variant="text" disabled={deleting} onPress={() => setConfirm(false)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {online ? t("deleteAccount.confirmText") : t("deleteAccount.needsNetwork")}
      </Dialog>
    </Screen>
  );
}

const styles = StyleSheet.create({
  notes: { gap: 12 },
  actions: { gap: 8 },
});
