import { Button, EmptyState } from "../design-system";
import { useT } from "../state/language";

/**
 * «Добавьте автомобиль» (TASK-028.B, requirement 1): the one state a person
 * without a car sees, whichever tab they are on. Before this task the
 * catalog tab (`NeedsCarScreen`) and the empty garage (`GarageView`) drew two
 * different empty states — their own heading, and the garage's had no
 * explanation at all. It is the same state (D-062: without a car there is no
 * catalog, and the garage that would fill it is itself empty), so it is one
 * component: the same icon, heading, explanation and button everywhere it
 * appears, not a screen each maintains on its own.
 *
 * The car icon (DESIGN 7.6) comes from the shared `Icon` component's `"car"`
 * name (`design-system/Icon.tsx`) — the one place that names the glyph, so
 * every place that shows it (this state, the garage's cards, the catalog's
 * car chip and sheet) changes together.
 */
export function NoCarContent({ onAdd }: { onAdd: () => void }) {
  const t = useT();
  return (
    <EmptyState
      icon="car"
      title={t("car.needCarTitle")}
      text={t("car.needCarText")}
      action={
        <Button icon="plus" onPress={onAdd}>
          {t("garage.add")}
        </Button>
      }
    />
  );
}
