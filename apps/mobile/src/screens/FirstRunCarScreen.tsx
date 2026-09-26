import { layout } from "@adclub/ui-core";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Icon, Screen, Text } from "../design-system";
import { CarPickerView } from "./garage/CarPickerView";
import { useT } from "../state/language";

/**
 * M-START-05 — the car of the first run. Only the list is available (photo
 * and voice are stage D), so the screen offers it and «Пропустить»; the
 * run is finished either way (SCREENS M-START-05). The choice itself is the
 * same M-GAR-03 the garage uses.
 */
export function FirstRunCarScreen({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [picking, setPicking] = useState(false);

  if (picking) {
    return <CarPickerView onSaved={onDone} onCancel={() => setPicking(false)} />;
  }

  return (
    <Screen
      footer={
        <>
          <Button icon="car" onPress={() => setPicking(true)}>
            {t("city.chooseFromList")}
          </Button>
          <Button variant="text" onPress={onDone}>
            {t("common.skip")}
          </Button>
        </>
      }
    >
      <View style={styles.content}>
        <Icon name="car" size={48} color="accent" />
        <Text variant="titleL" accessibilityRole="header">
          {t("start.carTitle")}
        </Text>
        <Text color="textMuted">{t("start.carText")}</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: layout.blockGap * 2,
    gap: 12,
  },
});
