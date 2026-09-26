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
  useToast,
} from "../../design-system";
import {
  applyOption,
  canSaveDraft,
  carToDraft,
  chosenLevels,
  clearFrom,
  draftToCar,
  EMPTY_DRAFT,
  EMPTY_PICKER_DATA,
  filterOptions,
  levelsClearedBy,
  resolveStage,
  type CarDraft,
  type CarStep,
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

export interface CarPickerViewProps {
  /** Filling in or editing a car the garage already holds. */
  car?: GarageCar;
  /** The step «Дополнить» asks for: it and everything below start empty. */
  startStep?: CarStep;
  onSaved: (car: GarageCar) => void;
  onCancel: () => void;
}

/**
 * M-GAR-03 — the step-by-step choice of a car. The screen owns no rules:
 * `pickerStage` says which step is next and what is on it, and every option
 * comes from `/vehicles/…`. Used both from the garage and from the first run
 * (M-START-05), so it is a plain component with callbacks, not a route.
 */
export function CarPickerView({ car, startStep, onSaved, onCancel }: CarPickerViewProps) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const garage = useGarage();

  const [draft, setDraft] = useState<CarDraft>(() => {
    if (!car) return EMPTY_DRAFT;
    const base = carToDraft(car);
    return startStep ? clearFrom(base, startStep) : base;
  });
  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState<CarLevel | null>(null);
  const [duplicate, setDuplicate] = useState<GarageCar | null>(null);

  // A step with a single option is taken by itself (M-GAR-03), and that is
  // a pure consequence of the data — not something an effect has to
  // remember to do. Each answer of the server is resolved as soon as it
  // arrives, and the next request is made for the level it settled: the
  // only make is taken, so its models are asked for, and so on down to the
  // modifications. `resolved` is the draft with all of that filled in.
  const currentYear = new Date().getFullYear();
  const stillMade = t("car.stillMade");
  const resolve = (from: CarDraft, data: PickerData) =>
    resolveStage({ draft: from, data, currentYear, stillMade });

  const makes = useVehicleMakes();
  const afterMakes: PickerData = { ...EMPTY_PICKER_DATA, makes: makes.data?.makes ?? null };
  const withMake = resolve(draft, afterMakes).draft;

  const models = useVehicleModels(withMake.make?.id ?? null);
  const afterModels: PickerData = { ...afterMakes, models: models.data?.models ?? null };
  const withModel = resolve(withMake, afterModels).draft;

  const generations = useVehicleGenerations(withModel.model?.id ?? null);
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
    setQuery("");
    setDraft(applyOption(resolved, step, option));
  };

  const editLevel = (level: CarLevel) => {
    if (levelsClearedBy(resolved, level).length > 0) {
      setConfirmReset(level);
      return;
    }
    setQuery("");
    setDraft(clearFrom(resolved, level));
  };

  const save = (force: boolean) => {
    const built = draftToCar(resolved, {
      id: car?.id ?? garage.nextId(),
      addedAt: car?.addedAt ?? new Date().toISOString(),
      modifications: data.modifications ?? [],
    });
    if (!built) return;
    if (!force) {
      const existing = garage.duplicateOf(built);
      if (existing) {
        setDuplicate(existing);
        return;
      }
    }
    if (car) garage.update(built);
    else garage.add(built);
    setDuplicate(null);
    toast.show(t("garage.added"));
    onSaved(built);
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

  return (
    <Screen
      title={stage.kind === "choose" ? t(STEP_TEXT[stage.step]) : t("car.title")}
      back={{ label: t("common.back"), onPress: onCancel }}
      scroll={false}
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
          <Button onPress={() => save(false)}>
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
        title={t("car.resetTitle")}
        actions={
          <>
            <Button
              onPress={() => {
                const level = confirmReset;
                setConfirmReset(null);
                setQuery("");
                if (level) setDraft(clearFrom(resolved, level));
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
        title={t("car.duplicateTitle")}
        actions={
          <>
            <Button onPress={() => save(true)}>{t("car.duplicateAdd")}</Button>
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
