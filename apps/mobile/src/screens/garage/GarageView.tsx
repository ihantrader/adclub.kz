import { layout, radius } from "@adclub/ui-core";
import { Pressable, StyleSheet, View } from "react-native";
import { Badge, Button, Icon, IconBadge, OfflineBanner, Screen, Text } from "../../design-system";
import { findCarColor } from "../../garage/car-color";
import { carParameters, carTitle, type GarageCar } from "../../garage/garage";
import { useOnline } from "../../services/use-network";
import { NoCarContent } from "../NoCarState";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { useSession } from "../../state/session-provider";
import { useTheme } from "../../design-system";

export interface GarageViewProps {
  onAdd: () => void;
  onOpen: (car: GarageCar) => void;
}

/**
 * M-GAR-01 — the garage. A guest's cars live on the device, so the screen
 * works without a network: the banner says there is none, the garage stays
 * (SCREENS 2.4). «Войдите — гараж сохранится» is a guest's note only: a
 * signed-in member was told it while already signed in (TASK-030.A).
 */
export function GarageView({ onAdd, onOpen }: GarageViewProps) {
  const t = useT();
  const online = useOnline();
  const { cars, state, makePrimary } = useGarage();
  const session = useSession();

  return (
    <Screen
      title={t("tabs.garage")}
      root
      centerContent={cars.length === 0}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      footer={
        cars.length > 0 ? (
          <Button icon="plus" onPress={onAdd}>
            {t("garage.add")}
          </Button>
        ) : null
      }
    >
      <View style={cars.length === 0 ? undefined : styles.content}>
        {cars.length === 0 ? (
          <NoCarContent onAdd={onAdd} />
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
            {/* The guest's note of M-GAR-01. */}
            {session.status === "guest" && (
              <Text variant="bodyS" color="textMuted" style={styles.note}>
                {t("garage.guestNote")}
              </Text>
            )}
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
        },
      ]}
    >
      <View style={styles.cardHead}>
        <IconBadge size={20}>
          <Icon name="car" size={20} color="accent" />
        </IconBadge>
        <View style={styles.grow}>
          <Text variant="bodyStrong">{carTitle(car)}</Text>
          {parameters.length > 0 ? (
            <Text variant="bodyS" color="textMuted">
              {parameters.join(" · ")}
            </Text>
          ) : null}
        </View>
        <Icon name="chevronRight" size={20} color="textMuted" />
      </View>
      {car.engine === null && (
        <Text variant="bodyS" color="warning">
          {t("garage.engineMissing")}
        </Text>
      )}
      {car.color !== null && (
        <View style={styles.colorRow}>
          <View
            style={[
              styles.swatch,
              {
                backgroundColor: findCarColor(car.color)?.swatch,
                borderColor: theme.colors.border,
              },
            ]}
          />
          <Text variant="bodyS" color="textMuted">
            {t(`car.color.${car.color}`)}
          </Text>
        </View>
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
  // `surface` sets the card apart from the page: no frame (DESIGN.md 7.6, D-068).
  card: {
    borderRadius: radius.m,
    padding: layout.cardPadding,
    gap: 8,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1, gap: 2 },
  colorRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 14, height: 14, borderRadius: 7, borderWidth: 1 },
  primaryButton: { alignSelf: "flex-start", paddingHorizontal: 0 },
  note: { paddingTop: 8 },
});
