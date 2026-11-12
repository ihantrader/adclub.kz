import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useNavigation } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback } from "react";
import { CatalogCarProvider } from "../catalog/catalog-car-provider";
import { catalogEntry } from "../catalog/catalog-gate";
import type { GarageCar } from "../garage/garage";
import { AssistantScreen } from "../screens/assistant/AssistantScreen";
import { ItemScreen } from "../screens/catalog/ItemScreen";
import { PartPhotoScreen } from "../screens/catalog/PartPhotoScreen";
import { Screen } from "../design-system";
import { NoCarContent } from "../screens/NoCarState";
import { useGarage } from "../state/garage-provider";
import { useCarPicker } from "./car-picker";
import type { AssistantStackParams, TabParams } from "./routes";
import { useStackScreenOptions } from "./use-stack-screen-options";

const Stack = createNativeStackNavigator<AssistantStackParams>();

/**
 * The AI Pilot tab (TASK-063; SCREENS M-AI-01; D-062): the assistant always
 * works for a car, so the rule of the catalog (`catalogEntry`) is its rule
 * too — with no car in the garage the tab is the one «Добавьте автомобиль»
 * screen (`NoCarContent`) and nothing else, read on every change of the
 * garage, so the last car deleted brings it back without a restart. With a
 * car it is the dialog for the main one: the same `CatalogCarProvider` as
 * the catalog, so choosing another car makes it the main one, and the card
 * of an item opened from an answer is the catalog's own (M-CAT-07).
 */
export function AssistantTab() {
  const { state } = useGarage();
  const carPicker = useCarPicker();
  const entry = catalogEntry(state);

  if (entry.kind === "needs-car") {
    return (
      <Screen title="AI Pilot" root centerContent>
        <NoCarContent onAdd={carPicker.add} />
      </Screen>
    );
  }
  return (
    <CatalogCarProvider car={entry.car}>
      <AssistantStack />
    </CatalogCarProvider>
  );
}

function AssistantStack() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="assistant-dialog" component={AssistantDialog} />
      <Stack.Screen name="assistant-item" component={AssistantItem} />
      <Stack.Screen name="assistant-part-photo" component={AssistantPartPhoto} />
    </Stack.Navigator>
  );
}

function useCatalogJumps() {
  const tabs = useNavigation<BottomTabNavigationProp<TabParams>>();
  return {
    toCatalog: () => tabs.navigate("catalog", { screen: "catalog-home" }),
    toSearch: () => tabs.navigate("catalog", { screen: "catalog-search", initial: false }),
  };
}

function AssistantDialog({
  route,
  navigation,
}: NativeStackScreenProps<AssistantStackParams, "assistant-dialog">) {
  const carPicker = useCarPicker();
  const { toCatalog, toSearch } = useCatalogJumps();
  return (
    <AssistantScreen
      {...(route.params?.draft !== undefined
        ? { draft: { text: route.params.draft, stamp: route.params.stamp ?? 0 } }
        : {})}
      onOpenItem={(item) =>
        navigation.navigate("assistant-item", { itemId: item.id, title: item.name })
      }
      onPhoto={() => navigation.navigate("assistant-part-photo")}
      onAddCar={carPicker.add}
      onCatalog={toCatalog}
      onSearch={toSearch}
    />
  );
}

function AssistantItem({
  route,
  navigation,
}: NativeStackScreenProps<AssistantStackParams, "assistant-item">) {
  const carPicker = useCarPicker();
  const completeEngine = useCallback(
    (car: GarageCar) => carPicker.edit(car, "engine"),
    [carPicker],
  );
  return (
    <ItemScreen
      itemId={route.params.itemId}
      {...(route.params.title ? { title: route.params.title } : {})}
      onBack={navigation.goBack}
      onOpenItem={(item) =>
        navigation.push("assistant-item", { itemId: item.id, title: item.name })
      }
      onCompleteCar={completeEngine}
      onAddCar={carPicker.add}
    />
  );
}

/**
 * M-CAT-06 from the dialog (TASK-058's path): the article read off the photo
 * goes back into the field of the dialog as text — the person sends it.
 */
function AssistantPartPhoto({
  navigation,
}: NativeStackScreenProps<AssistantStackParams, "assistant-part-photo">) {
  return (
    <PartPhotoScreen
      onBack={navigation.goBack}
      onFound={(found) =>
        navigation.popTo("assistant-dialog", { draft: found.article, stamp: Date.now() })
      }
      onTypeArticle={navigation.goBack}
    />
  );
}
