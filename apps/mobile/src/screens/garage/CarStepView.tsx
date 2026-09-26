import { layout } from "@adclub/ui-core";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  Button,
  Chip,
  DataState,
  Dialog,
  ListRow,
  Screen,
  SearchField,
  SkeletonList,
  Text,
  useAfterDismiss,
  useToast,
} from "../../design-system";
import {
  applyOption,
  canSaveDraft,
  chosenLevels,
  draftToCar,
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
import { carTitle, type CarLevel, type GarageCar } from "../../garage/garage";
import { useOnline } from "../../services/use-network";
import type { RequestState } from "../../services/use-request";
import {
  useVehicleGenerations,
  useVehicleMakes,
  useVehicleModels,
  useVehicleModifications,
} from "../../services/use-vehicles";
import { useGarage } from "../../state/garage-provider";
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
  /** The car of the garage being completed or edited. */
  car?: GarageCar;
  /**
   * The drafts of every screen of the choice, bottom to top — read when a
   * chosen value is tapped, to find the screen that asked for it.
   */
  screenDrafts: () => CarDraft[];
  /** Opens the next step: the draft with the chosen value added. */
  onNext: (draft: CarDraft) => void;
  /** Goes back to the screen that asked for a tapped value (and resets what it began from, when needed). */
  onJump: (jump: LevelJump) => void;
  onSaved: (car: GarageCar) => void;
  onBack: () => void;
  /**
   * Whether this screen is the one on top. A tap that arrives after the screen
   * has started to leave — a second tap on the same option, on «Сохранить
   * так» — is ignored, so a step is not opened twice and a car is not saved
   * twice.
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
 * screen of its own; a step no data exists for is skipped.
 */
export function CarStepView({
  draft,
  car,
  screenDrafts,
  onNext,
  onJump,
  onSaved,
  onBack,
  isActive,
}: CarStepViewProps) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const garage = useGarage();

  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState<CarLevel | null>(null);
  const [duplicate, setDuplicate] = useState<GarageCar | null>(null);
  // A dialog that closes and then something happens (the car is saved, the
  // steps go back): the action waits until the dialog has gone.
  const afterDialog = useAfterDismiss(confirmReset !== null || duplicate !== null);

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

  const commit = (built: GarageCar) => {
    if (!isActive()) return;
    if (car) garage.update(built);
    else garage.add(built);
    toast.show(t("garage.added"));
    onSaved(built);
  };

  const build = () =>
    draftToCar(resolved, {
      id: car?.id ?? garage.nextId(),
      addedAt: car?.addedAt ?? new Date().toISOString(),
      modifications: data.modifications ?? [],
    });

  const save = () => {
    if (!isActive()) return;
    const built = build();
    if (!built) return;
    const existing = garage.duplicateOf(built);
    if (existing) {
      setDuplicate(existing);
      return;
    }
    commit(built);
  };

  const saveAnyway = () => {
    const built = build();
    setDuplicate(null);
    if (built) afterDialog.after(() => commit(built));
  };

  const status =
    !online && pending
      ? "offline"
      : pending?.failure
        ? "error"
        : stage.kind === "load" || stage.kind === "auto"
          ? "loading"
          : "ready";

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
        canSave ? (
          <Button onPress={save}>
            {stage.kind === "done" ? t("common.done") : t("car.saveAsIs")}
          </Button>
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
          {stage.kind === "choose" ? (
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
          ) : (
            <View style={styles.summary}>
              <Text variant="heading">{summaryTitle(resolved)}</Text>
              <Text variant="bodyS" color="textMuted">
                {t("car.notListed")}
              </Text>
            </View>
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

      <Dialog
        visible={duplicate !== null}
        onClose={() => setDuplicate(null)}
        onDismissed={afterDialog.onDismissed}
        title={t("car.duplicateTitle")}
        actions={
          <>
            <Button onPress={saveAnyway}>{t("car.duplicateAdd")}</Button>
            <Button variant="secondary" onPress={() => setDuplicate(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {duplicate ? carTitle(duplicate) : ""}
      </Dialog>
    </Screen>
  );
}

function summaryTitle(draft: CarDraft): string {
  return chosenLevels(draft)
    .map((item) => item.label)
    .join(" · ");
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: layout.screenPadding, paddingTop: 8 },
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
  summary: { gap: 8, paddingVertical: layout.cardPadding },
});
