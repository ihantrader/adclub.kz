import { CommonActions, StackActions } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { clearFrom, jumpToLevel } from "../../garage/car-picker";
import type { CarLevel } from "../../garage/garage";
import type { CarStepParams, RootParams } from "../../navigation/routes";
import { useGarage } from "../../state/garage-provider";
import { firstRunStore } from "../../state/stores";
import { CarSummaryView } from "./CarSummaryView";

/**
 * The final step of M-GAR-03 (TASK-028.B, requirement 3), as a route of the
 * root stack, the same way as `CarStepScreen`. It sits on top of whichever
 * "car-step" screens the choice opened — none at all, when every level
 * settled by itself before any of them had to ask anything (`onEditLevel`
 * handles both).
 *
 * This is the only screen that saves a car: it builds it, asks about a
 * duplicate and writes it to the garage — a step screen only ever hands it a
 * finished draft (`CarStepScreen`), never saves one itself.
 */
export function CarSummaryScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootParams, "car-summary">) {
  const { cars } = useGarage();
  const { origin, carId, draft, color, recognition, unconfirmed } = route.params;
  const carried = {
    ...(recognition ? { recognition } : {}),
    ...(unconfirmed ? { unconfirmed } : {}),
  };
  const current = carId ? cars.find((item) => item.id === carId) : undefined;
  // A car being edited that another phone removed meanwhile (TASK-029.B)
  // stays the car being edited: saving it is a change of that car — the
  // server answers that it is gone — never a new car added in its place.
  const [last, setLast] = useState(current);
  if (current && current !== last) setLast(current);
  const car = current ?? last;

  /** Every step screen still under the summary, bottom to top. */
  const stepRoutes = () => navigation.getState().routes.filter((item) => item.name === "car-step");
  const screenDrafts = () => stepRoutes().map((item) => (item.params as CarStepParams).draft);

  return (
    <CarSummaryView
      draft={draft}
      color={color}
      {...(car ? { car } : {})}
      {...(recognition ? { recognition } : {})}
      unconfirmed={unconfirmed === true}
      // «Переснять» (M-GAR-05): back to the camera the photo was taken with.
      onRetake={() => {
        if (!navigation.isFocused()) return;
        const routes = navigation.getState().routes;
        const camera = routes.map((item) => item.name).lastIndexOf("car-document");
        if (camera >= 0) navigation.dispatch(StackActions.pop(routes.length - 1 - camera));
      }}
      isActive={() => navigation.isFocused()}
      onEditLevel={(level: CarLevel, current) => {
        const steps = stepRoutes();
        // No step screen is left under the summary (every level resolved by
        // itself, from the very screen the choice opened on): there is
        // nothing to pop back to, so a fresh step opens on top instead, and
        // «назад» from it returns to this summary — the only screen there is
        // to return to.
        if (steps.length === 0) {
          navigation.push("car-step", {
            origin,
            ...(carId ? { carId } : {}),
            draft: clearFrom(current, level),
            ...carried,
          });
          return;
        }
        const jump = jumpToLevel(screenDrafts(), level);
        const bottom = steps[0];
        if (jump.reset && bottom) {
          navigation.dispatch({
            ...CommonActions.setParams({ draft: jump.reset }),
            source: bottom.key,
          });
        }
        // +1 closes this summary screen itself, which sits above every step.
        navigation.dispatch(StackActions.pop(jump.pop + 1));
      }}
      onBack={() => {
        if (navigation.isFocused()) navigation.goBack();
      }}
      onSaved={() => {
        if (origin === "first-run") {
          // The car is in the garage: the first run is over. The tabs replace
          // the whole first run in one forward transition, so «назад» from
          // the catalog cannot lead back into it.
          firstRunStore.set({ completed: true, step: "car" });
          navigation.reset({
            index: 0,
            routes: [{ name: "tabs", params: { screen: "catalog" } }],
          });
          return;
        }
        navigation.dispatch(StackActions.popToTop());
      }}
    />
  );
}
