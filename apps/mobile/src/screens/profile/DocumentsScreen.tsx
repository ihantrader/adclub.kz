import { layout } from "@adclub/ui-core";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { appInfo, runEnvironment } from "../../config/environment";
import {
  Icon,
  ListGroup,
  ListRow,
  Screen,
  Section,
  SkeletonList,
  Text,
  useToast,
} from "../../design-system";
import type { ProfileStackParams } from "../../navigation/routes";
import {
  callOptions,
  detectWhatsapp,
  openCallOption,
  type CallOption,
} from "../../orders/call-options";
import { documentsRows, type DocumentsRow } from "../../profile/club-info";
import { useClubInfo } from "../../services/use-club-info";
import { useT } from "../../state/language";
import { useSession } from "../../state/session-provider";
import { CallSheet } from "../orders/CallSheet";

const pad = (value: number) => String(value).padStart(2, "0");

/** «16.10.2026» — locale-independent, like the dates of «Устройства». */
function formatDay(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

type LinkRow = Exclude<DocumentsRow, { kind: "consents" }>;

/**
 * M-PRO-06 «Документы и поддержка» (TASK-077), for a guest and a member:
 * the terms and the privacy policy, «Мои согласия» (what was accepted and
 * when — signed in only), «Связаться с клубом», the version of the app.
 * An item whose address the club has not set is not shown at all.
 */
export function DocumentsScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParams, "profile-documents">) {
  const t = useT();
  const { show } = useToast();
  const session = useSession();
  const info = useClubInfo();
  const [callSheet, setCallSheet] = useState<CallOption[] | null>(null);
  const rows = documentsRows(info.data, session.status === "signed_in");
  const links = rows.filter((row): row is LinkRow => row.kind !== "consents");
  const consents = rows.some((row) => row.kind === "consents");
  const profile = session.profile;
  const phoneShare = profile?.phoneShareConsent ?? null;

  const open = (url: string) => {
    Linking.openURL(url).catch(() => show(t("documents.openFailed")));
  };

  const openCall = async (option: CallOption) => {
    if (!(await openCallOption(option, (target) => Linking.openURL(target)))) {
      show(t("documents.openFailed"));
    }
  };

  /** A link opens as it is; a phone — by a call or in WhatsApp, as «Позвонить» of an order. */
  const contact = async (phone: string | null, url: string | null) => {
    if (url) {
      open(url);
      return;
    }
    const presence = await detectWhatsapp(runEnvironment, Platform.OS, (candidate) =>
      Linking.canOpenURL(candidate),
    );
    const options = callOptions(phone, presence);
    if (options.length > 1) setCallSheet(options);
    else if (options[0]) await openCall(options[0]);
  };

  return (
    <Screen
      title={t("profile.documents")}
      back={{ label: t("common.back"), onPress: navigation.goBack }}
    >
      <View style={styles.content}>
        {info.status === "loading" && !info.data && (
          <SkeletonList rows={2} label={t("common.loading")} />
        )}
        {links.length > 0 && (
          <Section>
            <ListGroup>
              {links.map((row, index) =>
                row.kind === "contact" ? (
                  <ListRow
                    key={row.kind}
                    first={index === 0}
                    icon="phone"
                    title={t("documents.contact")}
                    subtitle={row.phone ?? undefined}
                    navigates
                    onPress={() => void contact(row.phone, row.url)}
                  />
                ) : (
                  <ListRow
                    key={row.kind}
                    first={index === 0}
                    icon="info"
                    title={t(row.kind === "terms" ? "documents.terms" : "documents.privacy")}
                    trailing={<Icon name="externalLink" size={20} color="textMuted" />}
                    onPress={() => open(row.url)}
                  />
                ),
              )}
            </ListGroup>
          </Section>
        )}
        {consents && (
          <Section title={t("documents.consents")}>
            <ListGroup>
              <ListRow
                first
                icon="lock"
                title={t("documents.phoneShare")}
                subtitle={
                  phoneShare
                    ? t("documents.phoneShareGiven", {
                        date: formatDay(phoneShare.at),
                        version: phoneShare.version,
                      })
                    : t("documents.phoneShareMissing")
                }
              />
              <ListRow
                icon="info"
                title={t("documents.emailNews")}
                subtitle={t(
                  profile?.email && profile.emailNewsConsent
                    ? "documents.emailNewsOn"
                    : "documents.emailNewsOff",
                )}
              />
            </ListGroup>
          </Section>
        )}
        <Text variant="caption" color="textMuted" style={styles.version}>
          {t("profile.version")}: {appInfo.version}
        </Text>
      </View>

      <CallSheet
        visible={callSheet !== null}
        onClose={() => setCallSheet(null)}
        options={callSheet ?? []}
        onPick={(option) => void openCall(option)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 8 },
  version: { paddingTop: layout.blockGap },
});
