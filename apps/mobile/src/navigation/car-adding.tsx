import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Sheet, Text, useAfterDismiss } from "../design-system";
import { EMPTY_DRAFT } from "../garage/car-picker";
import { recognitionStart } from "../garage/document-flow";
import { listFallback, useListFallback } from "../garage/list-fallback";
import { VoiceInput } from "../screens/voice/VoiceInput";
import { matchVehicleText } from "../services/speech";
import { pickFromGallery } from "../services/vehicle-document";
import { voiceFailureOpensList, type VoiceAccepted } from "../speech/voice-input";
import { useT } from "../state/language";
import { ROOT_NAVIGATOR, type CarDocumentParams, type RootParams } from "./routes";

type Origin = "first-run" | "app";
type Picked = NonNullable<CarDocumentParams["picked"]>;

/**
 * The ways to add a car (D-064, TASK-057; SCREENS M-START-05, M-GAR-02):
 * the photo of the registration certificate first — the camera or the
 * gallery — and voice (TASK-060), and the list only after recognition did
 * not work (`listFallback`). One set of actions for the first run and for
 * the app, on the root stack, so whatever they open covers the tab that asked.
 */
export function useCarAdding(origin: Origin) {
  const navigation = useNavigation();
  return useMemo(() => {
    const root = () =>
      navigation.getParent<NativeStackNavigationProp<RootParams>>(ROOT_NAVIGATOR) ??
      (navigation as unknown as NativeStackNavigationProp<RootParams>);
    /** One screen of adding at a time: a second tap while one opens does nothing. */
    const opening = () => {
      const routes = root().getState().routes;
      const top = routes[routes.length - 1]?.name;
      return top === "car-document" || top === "car-step";
    };
    return {
      photo: () => {
        if (!opening()) root().push("car-document", { origin });
      },
      /**
       * The gallery, opened within the tap (a browser allows a file dialog
       * only then): the photo, or `null` — changed their mind, or no gallery
       * (then the list becomes the way left).
       */
      pick: async (): Promise<Picked | null> => {
        try {
          return await pickFromGallery();
        } catch {
          listFallback.allow();
          return null;
        }
      },
      openPicked: (picked: Picked) => {
        if (!opening()) root().push("car-document", { origin, picked });
      },
      list: () => {
        if (!opening()) root().push("car-step", { origin, draft: EMPTY_DRAFT, unconfirmed: true });
      },
      /**
       * A car said by voice (TASK-060): placed in the catalog by the server
       * (`POST /vehicles/match`, no AI) and put into the steps the way a
       * certificate is, marked «распознано»; no make of the catalog —
       * «Не поняли автомобиль».
       */
      said: async (text: string): Promise<VoiceAccepted> => {
        let answer;
        try {
          answer = await matchVehicleText(text);
        } catch (error) {
          return (error as { code?: unknown } | null)?.code === "NETWORK_ERROR"
            ? "offline"
            : "unavailable";
        }
        if (answer.result !== "found") return "not_understood";
        const start = recognitionStart(answer, undefined, "voice");
        return () => {
          if (!opening()) {
            root().push("car-step", { origin, draft: start.draft, recognition: start.recognition });
          }
        };
      },
    };
  }, [navigation, origin]);
}

/**
 * «Сказать голосом» of the ways to add a car (TASK-060): the voice sheet
 * for a car, and every failure of it opens «Выбрать из списка», as a
 * photo's does (`voiceFailureOpensList`).
 */
export function CarVoice({
  origin,
  visible,
  onClose,
}: {
  origin: Origin;
  visible: boolean;
  onClose: () => void;
}) {
  const adding = useCarAdding(origin);
  return (
    <VoiceInput
      visible={visible}
      onClose={onClose}
      purpose="vehicle"
      accept={adding.said}
      onType={() => {
        listFallback.allow();
        adding.list();
      }}
      onFailure={(failure) => {
        if (voiceFailureOpensList(failure)) listFallback.allow();
      }}
    />
  );
}

/** The buttons of M-START-05 and M-GAR-02: camera, gallery, voice, and the list when it is allowed. */
export function CarAddingActions({
  origin,
  before,
  onVoice,
}: {
  origin: Origin;
  /** Runs an action after the sheet the buttons are in has gone. */
  before?: (action: () => void) => void;
  /**
   * «Сказать голосом» opens the voice sheet of the screen that holds these
   * buttons (a sheet does not open over a sheet); absent — the buttons
   * hold their own.
   */
  onVoice?: () => void;
}) {
  const t = useT();
  const adding = useCarAdding(origin);
  const listAllowed = useListFallback();
  const [voice, setVoice] = useState(false);
  const run = (action: () => void) => (before ? before(action) : action());
  return (
    <View style={styles.actions}>
      {/* A pair of buttons shares one rule: no icon on either (TASK-078 M18). */}
      <Button onPress={() => run(adding.photo)}>{t("doc.photo")}</Button>
      <Button
        variant="secondary"
        onPress={() =>
          void adding.pick().then((picked) => {
            if (picked) run(() => adding.openPicked(picked));
          })
        }
      >
        {t("doc.gallery")}
      </Button>
      {/* No icon: the buttons of one list share one rule (TASK-078 M18). */}
      <Button
        variant="secondary"
        onPress={() => (onVoice ? onVoice() : setVoice(true))}
        disabled={voice}
      >
        {t("voice.say")}
      </Button>
      {listAllowed && (
        <>
          <Button variant="secondary" onPress={() => run(adding.list)}>
            {t("doc.chooseFromList")}
          </Button>
          <Text variant="caption" color="textMuted" style={styles.center}>
            {t("doc.listNote")}
          </Text>
        </>
      )}
      {!onVoice && <CarVoice origin={origin} visible={voice} onClose={() => setVoice(false)} />}
    </View>
  );
}

const AddCarContext = createContext<(() => void) | null>(null);

/**
 * M-GAR-02 — the sheet of the ways to add a car, for every «Добавить
 * автомобиль» inside the tabs (the garage, the catalog, its car switch).
 */
export function AddCarProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [voice, setVoice] = useState(false);
  const dismissed = useAfterDismiss(visible);
  const open = useCallback(() => setVisible(true), []);
  return (
    <AddCarContext.Provider value={open}>
      {children}
      <Sheet
        visible={visible}
        onClose={() => setVisible(false)}
        onDismissed={dismissed.onDismissed}
        title={t("doc.addTitle")}
        closeLabel={t("common.close")}
        closable
      >
        <View style={styles.sheet}>
          <Text variant="bodyS" color="textMuted">
            {t("doc.privacy")}
          </Text>
          <CarAddingActions
            origin="app"
            before={(action) => {
              setVisible(false);
              dismissed.after(action);
            }}
            onVoice={() => {
              // The voice sheet opens once this one has gone.
              setVisible(false);
              dismissed.after(() => setVoice(true));
            }}
          />
        </View>
      </Sheet>
      <CarVoice origin="app" visible={voice} onClose={() => setVoice(false)} />
    </AddCarContext.Provider>
  );
}

/** Opens M-GAR-02, or — outside the tabs — the camera at once. */
export function useAddCar(): () => void {
  const open = useContext(AddCarContext);
  const adding = useCarAdding("app");
  return open ?? adding.photo;
}

const styles = StyleSheet.create({
  actions: { gap: 12 },
  sheet: { gap: 12 },
  center: { textAlign: "center" },
});
