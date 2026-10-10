import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Sheet, Text, useAfterDismiss } from "../design-system";
import { EMPTY_DRAFT } from "../garage/car-picker";
import { listFallback, useListFallback } from "../garage/list-fallback";
import { pickFromGallery } from "../services/vehicle-document";
import { useT } from "../state/language";
import { ROOT_NAVIGATOR, type CarDocumentParams, type RootParams } from "./routes";

type Origin = "first-run" | "app";
type Picked = NonNullable<CarDocumentParams["picked"]>;

/**
 * The ways to add a car (D-064, TASK-057; SCREENS M-START-05, M-GAR-02):
 * the photo of the registration certificate first — the camera or the
 * gallery — and the list only after recognition did not work
 * (`listFallback`). One set of actions for the first run and for the app,
 * on the root stack, so whatever they open covers the tab that asked.
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
    };
  }, [navigation, origin]);
}

/** The buttons of M-START-05 and M-GAR-02: camera, gallery, and the list when it is allowed. */
export function CarAddingActions({
  origin,
  before,
}: {
  origin: Origin;
  /** Runs an action after the sheet the buttons are in has gone. */
  before?: (action: () => void) => void;
}) {
  const t = useT();
  const adding = useCarAdding(origin);
  const listAllowed = useListFallback();
  const run = (action: () => void) => (before ? before(action) : action());
  return (
    <View style={styles.actions}>
      <Button icon="scan" onPress={() => run(adding.photo)}>
        {t("doc.photo")}
      </Button>
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
          />
        </View>
      </Sheet>
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
  actions: { gap: 8 },
  sheet: { gap: 12 },
  center: { textAlign: "center" },
});
