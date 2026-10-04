import { layout } from "@adclub/ui-core";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  Button,
  Chip,
  DataState,
  Dialog,
  ListGroup,
  ListRow,
  Screen,
  SearchField,
  SkeletonList,
  Text,
  useAfterDismiss,
} from "../../design-system";
import {
  applyOption,
  canSaveDraft,
  chosenLevels,
  EMPTY_PICKER_DATA,
  filterOptions,
  firstUnsetLevel,
  jumpToLevel,
  levelsClearedBy,
  resolveStage,
  type CarDraft,
  type CarStep,
  type LevelJump,
  type PickerData,
  type PickerOption,
} from "../../garage/car-picker";
import type { CarLevel } from "../../garage/garage";
import { useOnline } from "../../services/use-network";
import type { RequestState } from "../../services/use-request";
import {
  useVehicleGenerations,
  useVehicleMakes,
  useVehicleModels,
  useVehicleModifications,
} from "../../services/use-vehicles";
import { useT } from "../../state/language";

const STEP_TEXT = {
  make: "car.step.make",
  model: "car.step.model",
  year: "car.step.year",
  generation: "car.step.generation",
  body: "car.step.body",
  engine: "car.step.engine",
  transmission: "car.step.transmission",
  drive: "car.step.drive",
} as const satisfies Record<CarStep, string>;

const LEVEL_TEXT = {
  make: "car.level.make",
  model: "car.level.model",
  year: "car.level.year",
  generation: "car.level.generation",
  body: "car.level.body",
  engine: "car.level.engine",
  transmission: "car.level.transmission",
  drive: "car.level.drive",
} as const satisfies Record<CarLevel, string>;

export interface CarStepViewProps {
  /** What had been decided when this screen opened — all of its state. */
  draft: CarDraft;
  /**
   * The drafts of every screen of the choice, bottom to top — read when a
   * chosen value is tapped, to find the screen that asked for it.
   */
  screenDrafts: () => CarDraft[];
  /** Opens the next step: the draft with the chosen value added. */
  onNext: (draft: CarDraft) => void;
  /** Goes back to the screen that asked for a tapped value (and resets what it began from, when needed). */
  onJump: (jump: LevelJump) => void;
  /** «Сохранить так» / «Готово», pressed on this screen: opens the final step on top of it. */
  onSummary: (draft: CarDraft) => void;
  /**
   * Every level resolved on its own, without this screen ever asking
   * anything: the final step replaces this screen instead of sitting on top
   * of it (see `CarStepScreen`).
   */
  onAutoSummary: (draft: CarDraft) => void;
  onBack: () => void;
  /**
   * Whether this screen is the one on top. A tap that arrives after the screen
   * has started to leave — a second tap on the same option, on «Сохранить
   * так» — is ignored, so a step is not opened twice and the final step does
   * not open twice either.
   */
  isActive: () => boolean;
}

/**
 * One step of M-GAR-03, the step-by-step choice of a car. The screen owns no
 * rules: `resolveStage` says which step is next and what is on it, and every
 * option comes from `/vehicles/…`. Each step is a screen of the stack
 * (ARCHITECTURE 4.39), so it moves in and out like every other screen of the
 * app and the system «назад» returns to the previous step.
 *
 * It asks for the first level its draft lacks. What the data settles by
 * itself — a make with one model — is taken on this screen and never gets a
 * screen of its own; a step no data exists for is skipped. Once nothing is
 * left to ask (`stage.kind === "done"`), this screen shows nothing of its
 * own either: it hands the resolved draft to the final step at once
 * (`onAutoSummary`) instead of a "Готово" the person would have to press on
 * an otherwise empty screen (TASK-028.B, requirement 3, edge case "все
 * параметры подобрались автоматически").
 */
export function CarStepView({
  draft,
  screenDrafts,
  onNext,
  onJump,
  onSummary,
  onAutoSummary,
  onBack,
  isActive,
}: CarStepViewProps) {
  const t = useT();
  const online = useOnline();

  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState<CarLevel | null>(null);
  // A dialog that closes and then something happens (the steps go back): the
  // action waits until the dialog has gone.
  const afterDialog = useAfterDismiss(confirmReset !== null);

  // A step with a single option is taken by itself (M-GAR-03), and that is
  // a pure consequence of the data — not something an effect has to
  // remember to do. Each answer of the server is resolved as soon as it
  // arrives, and the next request is made for the level it settled: the
  // only make is taken, so its models are asked for, and so on down to the
  // modifications. `resolved` is the draft with all of that filled in.
  //
  // Only what this screen still needs is asked for: a screen that opens with
  // the make and the model already chosen never asks for makes, and an answer
  // an earlier step already loaded is served from the short memory of the
  // flow (`use-vehicles.ts`) — a step opens with its options, not a skeleton.
  const currentYear = new Date().getFullYear();
  const stillMade = t("car.stillMade");
  const resolve = (from: CarDraft, data: PickerData) =>
    resolveStage({ draft: from, data, currentYear, stillMade });

  const makes = useVehicleMakes(draft.make === null);
  const afterMakes: PickerData = { ...EMPTY_PICKER_DATA, makes: makes.data?.makes ?? null };
  const withMake = resolve(draft, afterMakes).draft;

  const models = useVehicleModels(
    withMake.make && withMake.model === null ? withMake.make.id : null,
  );
  const afterModels: PickerData = { ...afterMakes, models: models.data?.models ?? null };
  const withModel = resolve(withMake, afterModels).draft;

  const generations = useVehicleGenerations(
    withModel.model && (withModel.year === null || withModel.generation === null)
      ? withModel.model.id
      : null,
  );
  const afterGenerations: PickerData = {
    ...afterModels,
    generations: generations.data?.generations ?? null,
  };
  const withGeneration = resolve(withModel, afterGenerations).draft;

  const modifications = useVehicleModifications(withGeneration.generation?.id ?? null);
  const data: PickerData = {
    ...afterGenerations,
    modifications: modifications.data?.modifications ?? null,
  };
  const { draft: resolved, stage } = resolve(withGeneration, data);

  const requests: Record<string, RequestState<unknown>> = {
    makes,
    models,
    generations,
    modifications,
  };
  const pending = stage.kind === "load" ? requests[stage.data] : undefined;

  // Fires once, the moment nothing is left to ask: the ref guards against a
  // second call (the effect can run again while this screen is still
  // mounted, waiting to be replaced) — a car must not open its final step
  // twice, let alone save twice.
  const autoFired = useRef(false);
  useEffect(() => {
    if (stage.kind === "done" && isActive() && !autoFired.current) {
      autoFired.current = true;
      onAutoSummary(resolved);
    }
    // `resolved` and `onAutoSummary` change every render; `autoFired` is what
    // actually stops a second call, so only `stage.kind` needs to be watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.kind]);

  const choose = (step: CarStep, option: PickerOption) => {
    if (!isActive()) return;
    onNext(applyOption(resolved, step, option));
  };

  // A tapped value goes back to the screen that asked for it. Nothing to do
  // when this very screen took the value by itself; a warning first when the
  // values below it would be lost (M-GAR-03).
  const editLevel = (level: CarLevel) => {
    if (!isActive()) return;
    const jump = jumpToLevel(screenDrafts(), level);
    if (jump.pop === 0 && jump.reset === null) return;
    if (levelsClearedBy(resolved, level).length > 0) {
      setConfirmReset(level);
      return;
    }
    onJump(jump);
  };

  const goToSummary = () => {
    if (!isActive()) return;
    onSummary(resolved);
  };

  const status =
    !online && pending
      ? "offline"
      : pending?.failure
        ? "error"
        : stage.kind === "choose"
          ? "ready"
          : // "auto", "load" and "done" all show the skeleton: "done" never
            // stays on screen long enough to draw anything else, and drawing
            // its own content here would be a step nobody asked for.
            "loading";

  const chosen = chosenLevels(resolved);
  const canSave = canSaveDraft(resolved);
  const searchable = stage.kind === "choose" && (stage.step === "make" || stage.step === "model");
  const options =
    stage.kind === "choose"
      ? searchable
        ? filterOptions(stage.options, query)
        : stage.options
      : [];

  // The title names the step while its data still loads: the level this
  // screen is about does not have to wait for the server to be read out.
  const provisional = firstUnsetLevel(resolved);
  const title =
    stage.kind === "choose"
      ? t(STEP_TEXT[stage.step])
      : stage.kind === "load" && provisional
        ? t(STEP_TEXT[provisional])
        : t("car.title");

  return (
    <Screen
      title={title}
      back={{ label: t("common.back"), onPress: onBack }}
      scroll={false}
      bottomInset
      header={
        chosen.length > 0 ? (
          <View style={styles.chosen}>
            {chosen.map((item) => (
              <Chip key={item.level} onPress={() => editLevel(item.level)}>
                {item.label}
              </Chip>
            ))}
          </View>
        ) : null
      }
      footer={
        // Available from the Year step on (`canSaveDraft`), even while later
        // levels are still resolving in the background — hidden only for the
        // instant `stage.kind` is "done", when this screen is already on its
        // way to being replaced by the final step (`onAutoSummary`).
        canSave && stage.kind !== "done" ? (
          <Button onPress={goToSummary}>{t("car.saveAsIs")}</Button>
        ) : null
      }
    >
      <View style={styles.body}>
        <DataState
          status={status}
          skeleton={<SkeletonList rows={5} label={t("common.loading")} />}
          error={{
            title: t("car.loadError"),
            text: t("state.errorText"),
            retry: { label: t("common.retry"), onRetry: () => pending?.reload() },
          }}
          offline={{
            title: t("state.offline"),
            text: t("state.offlineText"),
            action: (
              <Button variant="secondary" size="m" icon="refresh" onPress={() => pending?.reload()}>
                {t("common.retry")}
              </Button>
            ),
          }}
          empty={{ icon: "car", title: t("car.noOptions") }}
        >
          {stage.kind === "choose" && (
            <>
              {searchable && (
                <View style={styles.search}>
                  <SearchField
                    label={t("car.search")}
                    placeholder={t("car.search")}
                    value={query}
                    onChangeText={setQuery}
                    clearLabel={t("common.close")}
                  />
                </View>
              )}
              <ScrollView keyboardShouldPersistTaps="handled">
                {options.length > 0 && (
                  <ListGroup>
                    {options.map((option, index) => (
                      <ListRow
                        key={option.id}
                        first={index === 0}
                        title={option.label}
                        subtitle={option.hint}
                        navigates
                        onPress={() => choose(stage.step, option)}
                      />
                    ))}
                  </ListGroup>
                )}
                {options.length === 0 && (
                  <Text color="textMuted" style={styles.searchEmpty}>
                    {t("car.noOptions")}
                  </Text>
                )}
                <Text variant="caption" color="textMuted" style={styles.notListed}>
                  {t("car.notListed")}
                </Text>
              </ScrollView>
            </>
          )}
        </DataState>
      </View>

      <Dialog
        visible={confirmReset !== null}
        onClose={() => setConfirmReset(null)}
        onDismissed={afterDialog.onDismissed}
        title={t("car.resetTitle")}
        actions={
          <>
            <Button
              onPress={() => {
                const level = confirmReset;
                setConfirmReset(null);
                if (level) afterDialog.after(() => onJump(jumpToLevel(screenDrafts(), level)));
              }}
            >
              {t("common.continue")}
            </Button>
            <Button variant="secondary" onPress={() => setConfirmReset(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {t("car.resetText", {
          levels: (confirmReset ? levelsClearedBy(resolved, confirmReset) : [])
            .map((level) => t(LEVEL_TEXT[level]))
            .join(", "),
        })}
      </Dialog>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: layout.screenPadding, paddingTop: 12 },
  chosen: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: layout.screenPadding,
    paddingTop: 4,
    paddingBottom: 8,
  },
  search: { paddingBottom: 8 },
  searchEmpty: { paddingVertical: layout.cardPadding, textAlign: "center" },
  notListed: { paddingVertical: layout.cardPadding },
});
