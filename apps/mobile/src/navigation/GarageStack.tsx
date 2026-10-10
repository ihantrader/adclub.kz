import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Screen } from "../design-system";
import type { GarageCar } from "../garage/garage";
import { CarCardView } from "../screens/garage/CarCardView";
import { GarageView } from "../screens/garage/GarageView";
import { NoCarContent } from "../screens/NoCarState";
import { useGarage } from "../state/garage-provider";
import { useT } from "../state/language";
import { useCarPicker } from "./car-picker";
import type { GarageStackParams } from "./routes";
import { useStackScreenOptions } from "./use-stack-screen-options";

const Stack = createNativeStackNavigator<GarageStackParams>();

/**
 * The garage tab: the list (M-GAR-01) and a car (M-GAR-06). Choosing a car
 * (M-GAR-03) is not in this stack: its steps open above the tabs
 * (`useCarPicker`), so they look and move the same from here, from the
 * catalog and from the first run.
 */
export function GarageStack() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="garage-list" component={GarageListScreen} />
      <Stack.Screen name="garage-car" component={GarageCarScreen} />
    </Stack.Navigator>
  );
}

function GarageListScreen({
  navigation,
}: NativeStackScreenProps<GarageStackParams, "garage-list">) {
  const carPicker = useCarPicker();
  return (
    <GarageView
      onAdd={carPicker.add}
      onOpen={(car) => navigation.navigate("garage-car", { carId: car.id })}
    />
  );
}

function GarageCarScreen({
  route,
  navigation,
}: NativeStackScreenProps<GarageStackParams, "garage-car">) {
  const t = useT();
  const { cars } = useGarage();
  const carPicker = useCarPicker();
  const current = cars.find((item) => item.id === route.params.carId);

  // A car that was deleted keeps its card while the screen leaves: deleting
  // it removes it from the garage at once, and a card that turned into
  // «Гараж пуст» under the transition would be the screen changing as it slides
  // away. The last car this screen showed is kept until it is gone.
  const [last, setLast] = useState<GarageCar | undefined>(current);
  if (current && current !== last) setLast(current);
  const car = current ?? last;

  // The car does not exist (the app restarted on a card whose car was deleted elsewhere).
  if (!car) {
    return (
      <Screen
        title={t("tabs.garage")}
        back={{ label: t("common.back"), onPress: navigation.goBack }}
        centerContent
      >
        <NoCarContent onAdd={carPicker.add} />
      </Screen>
    );
  }

  return (
    <CarCardView
      car={car}
      onBack={navigation.goBack}
      // Back to the list, closing the card — not a new list on top of it. A
      // card that is the only screen of its stack (a restored or deep-linked
      // one) has no list under it to go back to, so the list replaces it.
      onDeleted={() =>
        navigation.getState().routes.length > 1
          ? navigation.popToTop()
          : navigation.replace("garage-list")
      }
      onEdit={(step) => carPicker.edit(car, step)}
      onConfirm={() => carPicker.confirm(car)}
    />
  );
}
