import type { ConsentKindValue } from "@adclub/contracts";
import { useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Button, Icon, ListGroup, ListRow, Sheet, Text, useToast } from "../../design-system";
import { CONSENT_LABEL } from "../../profile/account-deletion";
import { useClubInfo } from "../../services/use-club-info";
import { useOnline } from "../../services/use-network";
import { useT } from "../../state/language";

/**
 * «Мы обновили условия» (TASK-072, D-077): the texts the member agreed to
 * were updated; until they accept, orders are refused (`CONSENT_REQUIRED`) —
 * the catalog, the garage and the codes of their orders keep working, so
 * «Не сейчас» is allowed. The links are the club's documents (M-PRO-06).
 */
export function ConsentSheet({
  visible,
  outdated,
  onClose,
  onAccept,
}: {
  visible: boolean;
  outdated: readonly ConsentKindValue[];
  onClose: () => void;
  onAccept: () => Promise<void>;
}) {
  const t = useT();
  const { show } = useToast();
  const online = useOnline();
  const info = useClubInfo();
  const [saving, setSaving] = useState(false);
  const links = [
    info.data?.termsUrl
      ? { key: "terms", label: t("documents.terms"), url: info.data.termsUrl }
      : null,
    info.data?.privacyUrl
      ? { key: "privacy", label: t("documents.privacy"), url: info.data.privacyUrl }
      : null,
  ].filter((link): link is { key: string; label: string; url: string } => link !== null);

  const accept = async () => {
    setSaving(true);
    try {
      await onAccept();
    } catch {
      show(t("consents.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("consents.title")}
      closeLabel={t("common.close")}
    >
      <View style={styles.body}>
        <Text variant="body">{t("consents.text")}</Text>
        <View style={styles.kinds}>
          {outdated.map((kind) => (
            <Text key={kind} variant="body">
              {`· ${t(CONSENT_LABEL[kind])}`}
            </Text>
          ))}
        </View>
        {links.length > 0 && (
          <ListGroup>
            {links.map((link, index) => (
              <ListRow
                key={link.key}
                first={index === 0}
                icon="info"
                title={link.label}
                trailing={<Icon name="externalLink" size={20} color="textMuted" />}
                onPress={() => {
                  Linking.openURL(link.url).catch(() => show(t("documents.openFailed")));
                }}
              />
            ))}
          </ListGroup>
        )}
        <Button variant="primary" loading={saving} disabled={!online} onPress={() => accept()}>
          {t("consents.accept")}
        </Button>
        {!online && (
          <Text variant="caption" color="textMuted">
            {t("deleteAccount.needsNetwork")}
          </Text>
        )}
        <Button variant="text" align="center" onPress={onClose}>
          {t("consents.later")}
        </Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16 },
  kinds: { gap: 4 },
});
