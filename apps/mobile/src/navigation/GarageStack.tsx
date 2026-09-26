import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { EmptyState, Screen } from "../design-system";
import { CarCardView } from "../screens/garage/CarCardView";
import { CarPickerView } from "../screens/garage/CarPickerView";
import { GarageView } from "../screens/garage/GarageView";
import { useGarage } from "../state/garage-provider";
import { useT } from "../state/language";
import type { GarageStackParams } from "./routes";

const Stack = createNativeStackNavigator<GarageStackParams>();

/** The garage tab: the list (M-GAR-01), a car (M-GAR-06) and the choice (M-GAR-03). */
export function GarageStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="garage-list" component={GarageListScreen} />
      <Stack.Screen name="garage-car" component={GarageCarScreen} />
      <Stack.Screen name="garage-picker" component={GaragePickerScreen} />
    </Stack.Navigator>
  );
}

function GarageListScreen({
  navigation,
}: NativeStackScreenProps<GarageStackParams, "garage-list">) {
  return (
    <GarageView
      onAdd={() => navigation.navigate("garage-picker", {})}
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
  const car = cars.find((item) => item.id === route.params.carId);

  // The car was deleted from another screen (or the app restarted on it).
  if (!car) {
    return (
      <Screen
        title={t("tabs.garage")}
        back={{ label: t("common.back"), onPress: navigation.goBack }}
      >
        <EmptyState icon="car" title={t("garage.emptyTitle")} />
      </Screen>
    );
  }

  return (
    <CarCardView
      car={car}
      onBack={navigation.goBack}
      onDeleted={() => navigation.navigate("garage-list")}
      onEdit={(step) => navigation.navigate("garage-picker", { carId: car.id, step })}
    />
  );
}

function GaragePickerScreen({
  route,
  navigation,
}: NativeStackScreenProps<GarageStackParams, "garage-picker">) {
  const { cars } = useGarage();
  const car = route.params.carId ? cars.find((item) => item.id === route.params.carId) : undefined;

  return (
    <CarPickerView
      car={car}
      startStep={route.params.step}
      onCancel={navigation.goBack}
      onSaved={() => navigation.navigate("garage-list")}
    />
  );
}
