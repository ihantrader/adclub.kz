import type { MobileTextKey } from "@adclub/i18n";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { Icon, ListGroup, ListRow, Sheet, useAfterDismiss, useToast } from "../../design-system";
import { navigatorLinks, openNavigator, type NavigatorId } from "../../orders/pickup-place";
import { useLanguage } from "../../state/language";

const NAVIGATOR_TEXT = {
  yandexMaps: "navigator.yandexMaps",
  yandexNavi: "navigator.yandexNavi",
  twoGis: "navigator.twoGis",
  googleMaps: "navigator.googleMaps",
  appleMaps: "navigator.appleMaps",
} as const satisfies Record<NavigatorId, MobileTextKey>;

export interface NavigatorSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The address of the pickup point, exactly as the server gave it. */
  place: { address: string | null; cityName: string };
}

/**
 * «Маршрут» → «Открыть в…» (TASK-030.A, SCREENS M-ORD-03): the navigation
 * apps people in Kazakhstan use, each searching for the address. A press
 * opens the app; when it is not installed, the web of the same service —
 * so no choice leads nowhere. The point has no coordinates yet: the app
 * finds the address and the route is built there. The title says it all —
 * the list comes right under it (TASK-029.B, SCREENS M-ORD-03 block 4).
 *
 * The app opens once the sheet has gone («закрыть, потом идти»).
 */
export function NavigatorSheet({ visible, onClose, place }: NavigatorSheetProps) {
  const { t } = useLanguage();
  const toast = useToast();
  const dismissed = useAfterDismiss(visible);
  const links = navigatorLinks(place, Platform.OS);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onDismissed={dismissed.onDismissed}
      title={t("order.openIn")}
      closeLabel={t("common.close")}
    >
      <View style={styles.body}>
        <ListGroup>
          {links.map((link, index) => (
            <ListRow
              key={link.id}
              first={index === 0}
              icon="route"
              title={t(NAVIGATOR_TEXT[link.id])}
              trailing={<Icon name="externalLink" size={20} color="textMuted" />}
              onPress={() => {
                dismissed.after(() => {
                  void openNavigator(link, (url) => Linking.openURL(url)).then((opened) => {
                    if (!opened) toast.show(t("order.openFailed"));
                  });
                });
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
