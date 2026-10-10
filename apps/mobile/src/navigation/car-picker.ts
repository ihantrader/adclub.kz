import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { clearFrom, carToDraft, type CarStep } from "../garage/car-picker";
import type { GarageCar } from "../garage/garage";
import { useAddCar } from "./car-adding";
import { ROOT_NAVIGATOR, type CarStepParams, type RootParams } from "./routes";

/**
 * Opens the steps of choosing a car from anywhere in the app: the catalog,
 * the garage, the first run. The steps are screens of the root stack, above
 * the tabs, so they cover whichever tab asked for them and «назад» or saving
 * return to it — nothing jumps to another tab (ARCHITECTURE 4.39).
 *
 * Adding a car starts with the photo of the registration certificate since
 * TASK-057 (D-064): `add` opens the ways to add one (M-GAR-02), and the list
 * is one of them only after recognition did not work.
 *
 * A second press while the steps are already opening does nothing, so the
 * choice is never opened twice.
 */
export function useCarPicker() {
  const navigation = useNavigation();
  const add = useAddCar();
  return useMemo(() => {
    const open = (params: CarStepParams) => {
      const root = navigation.getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR);
      if (!root) return;
      const routes = root.getState().routes;
      if (routes[routes.length - 1]?.name === "car-step") return;
      root.push("car-step", params);
    };
    return {
      /** «Добавить автомобиль»: M-GAR-02. */
      add,
      /** «Дополнить» / editing a car: the choice starts at `step`, with what is above it kept. */
      edit: (car: GarageCar, step: CarStep) =>
        open({ origin: "app", carId: car.id, draft: clearFrom(carToDraft(car), step) }),
      /** «Подтвердить техпаспортом» (M-GAR-06): the camera for this car. */
      confirm: (car: GarageCar) => {
        const root = navigation.getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR);
        root?.push("car-document", { origin: "app", carId: car.id });
      },
    };
  }, [navigation, add]);
}
