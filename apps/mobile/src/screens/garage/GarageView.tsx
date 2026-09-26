import { layout, radius } from "@adclub/ui-core";
import { Pressable, StyleSheet, View } from "react-native";
import { Badge, Button, EmptyState, Icon, OfflineBanner, Screen, Text } from "../../design-system";
import { carParameters, carTitle, type GarageCar } from "../../garage/garage";
import { useOnline } from "../../services/use-network";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { useTheme } from "../../design-system";

export interface GarageViewProps {
  onAdd: () => void;
  onOpen: (car: GarageCar) => void;
}

/**
 * M-GAR-01 — the garage. A guest's cars live on the device, so the screen
 * works without a network: the banner says there is none, the garage stays
 * (SCREENS 2.4). Signing in is TASK-029, so the note about it leads nowhere
 * yet and is only a note.
 */
export function GarageView({ onAdd, onOpen }: GarageViewProps) {
  const t = useT();
  const online = useOnline();
  const { cars, state, makePrimary } = useGarage();

  return (
    <Screen
      title={t("tabs.garage")}
      root
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      footer={
        cars.length > 0 ? (
          <Button icon="plus" onPress={onAdd}>
            {t("garage.add")}
          </Button>
        ) : null
      }
    >
      <View style={styles.content}>
        {cars.length === 0 ? (
          <EmptyState
            icon="car"
            title={t("garage.emptyTitle")}
            action={
              <Button icon="plus" onPress={onAdd}>
                {t("garage.add")}
              </Button>
            }
          />
        ) : (
          <View style={styles.list}>
            {cars.map((car) => (
              <CarCard
                key={car.id}
                car={car}
                primary={car.id === state.primaryId}
                onOpen={() => onOpen(car)}
                onMakePrimary={() => makePrimary(car.id)}
              />
            ))}
            {/* The guest's note of M-GAR-01; signing in arrives with TASK-029. */}
            <Text variant="bodyS" color="textMuted" style={styles.note}>
              {t("garage.guestNote")}
            </Text>
          </View>
        )}
      </View>
    </Screen>
  );
}

function CarCard({
  car,
  primary,
  onOpen,
  onMakePrimary,
}: {
  car: GarageCar;
  primary: boolean;
  onOpen: () => void;
  onMakePrimary: () => void;
}) {
  const t = useT();
  const { theme } = useTheme();
  const parameters = carParameters(car);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.surface,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View style={styles.cardHead}>
        <Text variant="bodyStrong" style={styles.grow}>
          {carTitle(car)}
        </Text>
        <Icon name="chevronRight" size={20} color="textMuted" />
      </View>
      {parameters.length > 0 ? (
        <Text variant="bodyS" color="textMuted">
          {parameters.join(" · ")}
        </Text>
      ) : null}
      {car.engine === null && (
        <Text variant="bodyS" color="warning">
          {t("garage.engineMissing")}
        </Text>
      )}
      {primary ? (
        <Badge tone="accent" icon="check">
          {t("garage.primary")}
        </Badge>
      ) : (
        <Button variant="text" size="m" onPress={onMakePrimary} style={styles.primaryButton}>
          {t("garage.makePrimary")}
        </Button>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12 },
  list: { gap: 12 },
  card: {
    borderWidth: 1,
    borderRadius: radius.m,
    padding: layout.cardPadding,
    gap: 8,
  },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  grow: { flex: 1 },
  primaryButton: { alignSelf: "flex-start", paddingHorizontal: 0 },
  note: { paddingTop: 8 },
});
