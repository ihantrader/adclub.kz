import { layout, radius } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  Badge,
  Banner,
  Button,
  Icon,
  OfflineBanner,
  Screen,
  ScreenBody,
  Text,
  useToast,
} from "../../design-system";
import { joinDot } from "../../catalog/format";
import { findCarColor } from "../../garage/car-color";
import { carParameters, carTitle, type GarageCar } from "../../garage/garage";
import { useSignIn } from "../../navigation/use-sign-in";
import { useOnline } from "../../services/use-network";
import { NoCarContent } from "../NoCarState";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { useSession } from "../../state/session-provider";
import { useTheme } from "../../design-system";
import { garageErrorText } from "./garage-errors";

export interface GarageViewProps {
  onAdd: () => void;
  onOpen: (car: GarageCar) => void;
}

/**
 * M-GAR-01 — the garage. A guest's cars live on the device, so the screen
 * works without a network: the banner says there is none, the garage stays
 * (SCREENS 2.4). «Войдите — гараж сохранится» is a guest's note only — a
 * banner with «Войти» (TASK-078), not a grey line nobody can press.
 *
 * Signed in, the garage is the account's (TASK-029.B): opening the tab reads
 * it again, so a car added or removed on another phone shows here; without a
 * network the copy is shown and «Сделать основным» is off.
 */
export function GarageView({ onAdd, onOpen }: GarageViewProps) {
  const t = useT();
  const online = useOnline();
  const { cars, state, remote, makePrimary, sync } = useGarage();
  const session = useSession();
  const signIn = useSignIn();
  const toast = useToast();
  const offline = remote && !online;
  const [pendingPrimary, setPendingPrimary] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (remote) void sync();
    }, [remote, sync]),
  );

  const choosePrimary = async (carId: string) => {
    setPendingPrimary(carId);
    try {
      await makePrimary(carId);
    } catch (error) {
      toast.show(garageErrorText(error, t));
    } finally {
      setPendingPrimary(null);
    }
  };

  return (
    <Screen
      title={t("tabs.garage")}
      root
      centerContent={cars.length === 0}
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      footer={cars.length > 0 ? <Button onPress={onAdd}>{t("garage.add")}</Button> : null}
    >
      {cars.length === 0 ? (
        <NoCarContent onAdd={onAdd} />
      ) : (
        <ScreenBody>
          <View style={styles.list}>
            {cars.map((car) => (
              <CarCard
                key={car.id}
                car={car}
                primary={car.id === state.primaryId}
                onOpen={() => onOpen(car)}
                onMakePrimary={() => void choosePrimary(car.id)}
                primaryPending={pendingPrimary === car.id}
                offline={offline}
              />
            ))}
            {/* The guest's note of M-GAR-01, with the way in. */}
            {session.status === "guest" && (
              <Banner
                icon="user"
                action={
                  <Button variant="text" size="m" onPress={signIn.start}>
                    {t("auth.signIn")}
                  </Button>
                }
              >
                {t("garage.guestNote")}
              </Banner>
            )}
          </View>
        </ScreenBody>
      )}
    </Screen>
  );
}

/**
 * A card of a car: one column (TASK-078) — the name with the chevron, the
 * parameters as one line through «·», the colour, «Основной» or the way to
 * make it so.
 */
function CarCard({
  car,
  primary,
  onOpen,
  onMakePrimary,
  primaryPending,
  offline,
}: {
  car: GarageCar;
  primary: boolean;
  onOpen: () => void;
  onMakePrimary: () => void;
  primaryPending: boolean;
  /** Signed in without a network: the main car cannot change now. */
  offline: boolean;
}) {
  const t = useT();
  const { theme } = useTheme();
  const parameters = joinDot(carParameters(car));
  const color = car.color !== null ? findCarColor(car.color) : undefined;

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
        <View style={styles.grow}>
          <Text variant="bodyStrong">{carTitle(car)}</Text>
          {parameters !== "" && (
            <Text variant="bodyS" color="textMuted">
              {parameters}
            </Text>
          )}
        </View>
        <Icon name="chevronRight" size={20} color="textMuted" />
      </View>
      {car.engine === null && (
        <Text variant="bodyS" color="warning">
          {t("garage.engineMissing")}
        </Text>
      )}
      {color && (
        <View style={styles.colorRow}>
          {/* A ring of `borderField`, so white reads on a white card (M19). */}
          <View
            style={[
              styles.swatch,
              { backgroundColor: color.swatch, borderColor: theme.colors.borderField },
            ]}
          />
          <Text variant="bodyS" color="textMuted">
            {t(`car.color.${car.color!}`)}
          </Text>
        </View>
      )}
      {primary ? (
        <Badge tone="accent" icon="check">
          {t("garage.primary")}
        </Badge>
      ) : (
        <View style={styles.primaryRow}>
          <Button
            variant="text"
            size="m"
            onPress={onMakePrimary}
            loading={primaryPending}
            disabled={offline}
          >
            {t("garage.makePrimary")}
          </Button>
          {offline && (
            <Text variant="caption" color="textMuted">
              {t("garage.needsNetwork")}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  primaryRow: { flexDirection: "row", alignItems: "center", gap: 8 },
});
