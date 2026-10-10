import { CommonActions, StackActions } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { CarStepParams, RootParams } from "../../navigation/routes";
import type { CarDraft, LevelJump } from "../../garage/car-picker";
import { useGarage } from "../../state/garage-provider";
import { CarStepView } from "./CarStepView";

/**
 * A step of M-GAR-03 as a route of the root stack (ARCHITECTURE 4.39).
 *
 * The screen's whole state is `route.params.draft`, so the stack is the
 * history: opening the next step is a `push` of this route with the chosen
 * value added, and going back — the arrow, the edge swipe, the Android
 * button — is the route underneath, still showing the step it was.
 *
 * Nothing here saves a car any more (TASK-028.B): every path that used to
 * finish the choice now opens the final step (`car-summary`) instead, which
 * is the only place a car is built, checked for a duplicate and written to
 * the garage (requirement 3 — a person always sees the whole car, including
 * what was picked for them, before it is saved).
 */
export function CarStepScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootParams, "car-step">) {
  const { cars } = useGarage();
  const { origin, carId, draft, recognition, unconfirmed } = route.params;
  const car = carId ? cars.find((item) => item.id === carId) : undefined;
  // What a photographed certificate brought, or that the list was chosen
  // after it did not work (TASK-057): carried through every step to the end.
  const carried = {
    ...(recognition ? { recognition } : {}),
    ...(unconfirmed ? { unconfirmed } : {}),
  };

  /** Every step screen of the choice, bottom to top (there is one choice at a time). */
  const stepRoutes = () => navigation.getState().routes.filter((item) => item.name === "car-step");
  const screenDrafts = () => stepRoutes().map((item) => (item.params as CarStepParams).draft);

  const openSummary = (resolved: CarDraft) => ({
    origin,
    ...(carId ? { carId } : {}),
    draft: resolved,
    color: car?.color ?? recognition?.color ?? null,
    ...carried,
  });

  return (
    <CarStepView
      // A screen that takes another draft in place (a chosen value tapped on
      // the first screen of a car being completed) starts again: the text in
      // its search field and whatever else it held belong to the step it left.
      key={JSON.stringify(draft)}
      draft={draft}
      {...(recognition ? { recognition } : {})}
      screenDrafts={screenDrafts}
      isActive={() => navigation.isFocused()}
      onNext={(next) =>
        navigation.push("car-step", {
          origin,
          ...(carId ? { carId } : {}),
          draft: next,
          ...carried,
        })
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
      // «Готово» / «Сохранить так»: the user is looking at this screen, so
      // «назад» from the summary must return to it — a `push`, on top of it.
      onSummary={(resolved) => navigation.push("car-summary", openSummary(resolved))}
      // Every level settled without asking: this screen never showed a step
      // of its own, so it must not stay in the stack as a silent one either —
      // «назад» from the summary has to land on the step that really is the
      // last one (or, with none at all, on whatever opened the choice).
      onAutoSummary={(resolved) => navigation.replace("car-summary", openSummary(resolved))}
      // One step back per press: a press on a screen that is already leaving
      // (a second tap on the arrow) must not close the step under it as well.
      onBack={() => {
        if (navigation.isFocused()) navigation.goBack();
      }}
    />
  );
}
