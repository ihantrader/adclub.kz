import { CommonActions, StackActions } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { CarStepParams, RootParams } from "../../navigation/routes";
import type { LevelJump } from "../../garage/car-picker";
import { useGarage } from "../../state/garage-provider";
import { firstRunStore } from "../../state/stores";
import { CarStepView } from "./CarStepView";

/**
 * A step of M-GAR-03 as a route of the root stack (ARCHITECTURE 4.39).
 *
 * The screen's whole state is `route.params.draft`, so the stack is the
 * history: opening the next step is a `push` of this route with the chosen
 * value added, and going back — the arrow, the edge swipe, the Android
 * button — is the route underneath, still showing the step it was. Saving
 * closes every step at once and returns where the choice began: the app, to
 * the tab it came from; the first run, to the tabs — which is the end of the
 * first run, because it ends when a car has been added (D-062).
 */
export function CarStepScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootParams, "car-step">) {
  const { cars } = useGarage();
  const { origin, carId, draft } = route.params;
  const car = carId ? cars.find((item) => item.id === carId) : undefined;

  /** Every step screen of the choice, bottom to top (there is one choice at a time). */
  const stepRoutes = () => navigation.getState().routes.filter((item) => item.name === "car-step");
  const screenDrafts = () => stepRoutes().map((item) => (item.params as CarStepParams).draft);

  return (
    <CarStepView
      // A screen that takes another draft in place (a chosen value tapped on
      // the first screen of a car being completed) starts again: the text in
      // its search field and whatever else it held belong to the step it left.
      key={JSON.stringify(draft)}
      draft={draft}
      {...(car ? { car } : {})}
      screenDrafts={screenDrafts}
      isActive={() => navigation.isFocused()}
      onNext={(next) =>
        navigation.push("car-step", { origin, ...(carId ? { carId } : {}), draft: next })
      }
      onJump={(jump: LevelJump) => {
        const steps = stepRoutes();
        // The car being completed already had this value: the bottom screen
        // starts again from it before the others are closed.
        const bottom = steps[0];
        if (jump.reset && bottom) {
          navigation.dispatch({
            ...CommonActions.setParams({ draft: jump.reset }),
            source: bottom.key,
          });
        }
        if (jump.pop > 0) navigation.dispatch(StackActions.pop(jump.pop));
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
      // One step back per press: a press on a screen that is already leaving
      // (a second tap on the arrow) must not close the step under it as well.
      onBack={() => {
        if (navigation.isFocused()) navigation.goBack();
      }}
    />
  );
}
