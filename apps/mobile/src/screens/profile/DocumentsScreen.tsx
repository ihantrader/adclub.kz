import { formatKzPhone } from "@adclub/domain";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Linking, Platform } from "react-native";
import { appInfo, runEnvironment } from "../../config/environment";
import {
  Icon,
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
import { useNow, useOrderTime } from "../orders/parts";

type LinkRow = Exclude<DocumentsRow, { kind: "consents" }>;

/**
 * M-PRO-06 «Документы и поддержка» (TASK-077), for a guest and a member:
 * the terms and the privacy policy, «Мои согласия» (what was accepted and
 * when — signed in only), «Связаться с клубом», the version of the app as
 * the last row of the group. An item whose address the club has not set is
 * not shown; while there are none, the screen says documents will appear
 * here (TASK-078).
 */
export function DocumentsScreen({
  navigation,
}: NativeStackScreenProps<ProfileStackParams, "profile-documents">) {
  const t = useT();
  const { show } = useToast();
  const session = useSession();
  const info = useClubInfo();
  const now = useNow();
  const time = useOrderTime();
  const [callSheet, setCallSheet] = useState<CallOption[] | null>(null);
  const rows = documentsRows(info.data, session.status === "signed_in");
  const links = rows.filter((row): row is LinkRow => row.kind !== "consents");
  const consents = rows.some((row) => row.kind === "consents");
  const profile = session.profile;
  const phoneShare = profile?.phoneShareConsent ?? null;
  const loading = info.status === "loading" && !info.data;

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
      <ScreenBody>
        <Section first>
          {loading ? (
            <SkeletonList rows={2} label={t("common.loading")} />
          ) : (
            <ListGroup>
              {links.length === 0 && (
                <ListRow
                  first
                  icon="info"
                  title={
                    <Text variant="body" color="textMuted">
                      {t("documents.empty")}
                    </Text>
                  }
                />
              )}
              {links.map((row, index) =>
                row.kind === "contact" ? (
                  <ListRow
                    key={row.kind}
                    first={index === 0}
                    icon="phone"
                    title={t("documents.contact")}
                    subtitle={row.phone ? formatKzPhone(row.phone) : undefined}
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
              <ListRow
                title={
                  <Text variant="body" color="textMuted">
                    {t("profile.version")}
                  </Text>
                }
                trailing={<Text variant="bodyS">{appInfo.version}</Text>}
              />
            </ListGroup>
          )}
        </Section>
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
                        date: time.whenDay(phoneShare.at, null, now),
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
      </ScreenBody>

      <CallSheet
        visible={callSheet !== null}
        onClose={() => setCallSheet(null)}
        options={callSheet ?? []}
        onPick={(option) => void openCall(option)}
      />
    </Screen>
  );
}
