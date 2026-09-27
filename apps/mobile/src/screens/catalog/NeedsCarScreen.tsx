import { Screen } from "../../design-system";
import { NoCarContent } from "../NoCarState";
import { useT } from "../../state/language";

/**
 * The whole catalog tab while the garage has no car (D-062, SCREENS
 * M-CAT-01): «Добавьте автомобиль», one line of why, one button into the
 * step-by-step choice. No categories, no search, no services, no city — the
 * catalog does not exist for a person without a car, and a screen that
 * showed a piece of it would be a way to look without one.
 *
 * The content itself — icon, heading, explanation, button — is
 * `NoCarContent` (TASK-028.B): the empty garage (`GarageView`) shows exactly
 * the same one, so the two screens that name this state agree on its words.
 *
 * Registration is not asked for: a guest adds a car and uses the catalog for
 * it; signing in is for an order (PRODUCT 6.6).
 */
export function NeedsCarScreen({ onAddCar }: { onAddCar: () => void }) {
  const t = useT();
  return (
    <Screen title={t("tabs.catalog")} root centerContent>
      <NoCarContent onAdd={onAddCar} />
    </Screen>
  );
}
