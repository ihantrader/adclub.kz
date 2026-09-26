import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { clearFrom, carToDraft, EMPTY_DRAFT, type CarStep } from "../garage/car-picker";
import type { GarageCar } from "../garage/garage";
import { ROOT_NAVIGATOR, type CarStepParams, type RootParams } from "./routes";

/**
 * Opens the steps of choosing a car from anywhere in the app: the catalog,
 * the garage, the first run. The steps are screens of the root stack, above
 * the tabs, so they cover whichever tab asked for them and «назад» or saving
 * return to it — nothing jumps to another tab (ARCHITECTURE 4.39).
 *
 * A second press while the steps are already opening does nothing, so the
 * choice is never opened twice.
 */
export function useCarPicker() {
  const navigation = useNavigation();
  return useMemo(() => {
    const open = (params: CarStepParams) => {
      const root = navigation.getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR);
      if (!root) return;
      const routes = root.getState().routes;
      if (routes[routes.length - 1]?.name === "car-step") return;
      root.push("car-step", params);
    };
    return {
      /** «Добавить автомобиль». */
      add: () => open({ origin: "app", draft: EMPTY_DRAFT }),
      /** «Дополнить» / editing a car: the choice starts at `step`, with what is above it kept. */
      edit: (car: GarageCar, step: CarStep) =>
        open({ origin: "app", carId: car.id, draft: clearFrom(carToDraft(car), step) }),
    };
  }, [navigation]);
}
