import { StyleSheet, View } from "react-native";
import { Icon, ListGroup, ListRow, Sheet, useAfterDismiss } from "../../design-system";
import type { CallOption } from "../../orders/call-options";
import { useLanguage } from "../../state/language";

export interface CallSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The phone first, then the WhatsApp apps that are there (`callOptions`). */
  options: readonly CallOption[];
  onPick: (option: CallOption) => void;
}

/**
 * «Позвонить» → «Позвонить через…» (TASK-029.B, SCREENS M-ORD-03 block 4):
 * «Телефон» always, «WhatsApp» and «WhatsApp Business» only when they are on
 * the phone. The names of the apps are not translated. A WhatsApp row opens
 * the chat with the supplier — there is no public link that starts a call —
 * and says so under its name.
 *
 * The app opens once the sheet has gone, like «Открыть в…».
 */
export function CallSheet({ visible, onClose, options, onPick }: CallSheetProps) {
  const { t } = useLanguage();
  const dismissed = useAfterDismiss(visible);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onDismissed={dismissed.onDismissed}
      title={t("order.callVia")}
      closeLabel={t("common.close")}
    >
      <View style={styles.body}>
        <ListGroup>
          {options.map((option, index) => (
            <ListRow
              key={option.id}
              first={index === 0}
              icon="phone"
              title={
                option.id === "phone"
                  ? t("order.callPhone")
                  : option.id === "whatsapp"
                    ? "WhatsApp"
                    : "WhatsApp Business"
              }
              subtitle={option.id === "phone" ? undefined : t("order.callWhatsappNote")}
              trailing={
                option.id === "phone" ? null : (
                  <Icon name="externalLink" size={20} color="textMuted" />
                )
              }
              onPress={() => {
                dismissed.after(() => onPick(option));
                onClose();
              }}
            />
          ))}
        </ListGroup>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingBottom: 8 },
});
