import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useCallback } from "react";
import { CatalogCarProvider } from "../catalog/catalog-car-provider";
import { catalogEntry } from "../catalog/catalog-gate";
import type { GarageCar } from "../garage/garage";
import { CatalogHomeScreen } from "../screens/catalog/CatalogHomeScreen";
import { ItemListScreen } from "../screens/catalog/ItemListScreen";
import { ItemScreen } from "../screens/catalog/ItemScreen";
import { NeedsCarScreen } from "../screens/catalog/NeedsCarScreen";
import { SubcategoriesScreen } from "../screens/catalog/SubcategoriesScreen";
import { useGarage } from "../state/garage-provider";
import { useCarPicker } from "./car-picker";
import type { CatalogStackParams, TabParams } from "./routes";
import { useStackScreenOptions } from "./use-stack-screen-options";

const Stack = createNativeStackNavigator<CatalogStackParams>();

/**
 * The catalog tab (D-062): the catalog exists only for a person with a car.
 * With no car in the garage the tab is one screen — «Добавьте автомобиль» —
 * and nothing else; with a car it is the catalog for the main one. The rule
 * is `catalogEntry`, and it is read on every change of the garage, so the
 * last car deleted brings the «add a car» screen back without a restart, and
 * the first car added opens the catalog fresh, at its main screen.
 */
export function CatalogTab() {
  const { state } = useGarage();
  const carPicker = useCarPicker();
  const entry = catalogEntry(state);

  if (entry.kind === "needs-car") return <NeedsCarScreen onAddCar={carPicker.add} />;
  return (
    <CatalogCarProvider car={entry.car}>
      <CatalogStack />
    </CatalogCarProvider>
  );
}

/** The catalog for a car: main screen → subcategories → items → item card. */
function CatalogStack() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="catalog-home" component={CatalogHome} />
      <Stack.Screen name="catalog-node" component={CatalogNode} />
      <Stack.Screen name="catalog-items" component={CatalogItems} />
      <Stack.Screen name="catalog-item" component={CatalogItem} />
    </Stack.Navigator>
  );
}

/**
 * The garage is a tab of its own, so «Проверить параметры автомобиля» from
 * the catalog jumps to the car's card there instead of opening a second copy
 * of the same screen. Adding a car and completing one do not jump anywhere:
 * the steps of the choice open above the tabs (`useCarPicker`).
 */
function useGarageJump() {
  const tabs = useNavigation<BottomTabNavigationProp<TabParams>>();
  const carPicker = useCarPicker();
  const openCar = useCallback(
    (carId: string) =>
      // `initial: false` keeps the list of the garage under the card even when
      // the garage tab has never been opened: a tab that was not mounted yet
      // would otherwise start with the card alone, and there would be nothing
      // to go back to when the car is deleted.
      tabs.navigate("garage", { screen: "garage-car", params: { carId }, initial: false }),
    [tabs],
  );
  const completeEngine = useCallback(
    (car: GarageCar) => carPicker.edit(car, "engine"),
    [carPicker],
  );
  return { addCar: carPicker.add, openCar, completeEngine };
}

function CatalogHome({ navigation }: NativeStackScreenProps<CatalogStackParams, "catalog-home">) {
  const { addCar, completeEngine } = useGarageJump();
  return (
    <CatalogHomeScreen
      onOpenNode={(node) =>
        navigation.navigate("catalog-node", { categoryId: node.id, title: node.name.text })
      }
      onAddCar={addCar}
      onCompleteEngine={completeEngine}
    />
  );
}

function CatalogNode({
  route,
  navigation,
}: NativeStackScreenProps<CatalogStackParams, "catalog-node">) {
  return (
    <SubcategoriesScreen
      categoryId={route.params.categoryId}
      {...(route.params.title ? { title: route.params.title } : {})}
      onBack={navigation.goBack}
      onOpen={(subcategory) =>
        navigation.navigate("catalog-items", {
          categoryId: subcategory.id,
          title: subcategory.name.text,
        })
      }
    />
  );
}

function CatalogItems({
  route,
  navigation,
}: NativeStackScreenProps<CatalogStackParams, "catalog-items">) {
  const { addCar, openCar } = useGarageJump();
  return (
    <ItemListScreen
      categoryId={route.params.categoryId}
      {...(route.params.title ? { title: route.params.title } : {})}
      onBack={navigation.goBack}
      onOpenItem={(item) =>
        navigation.navigate("catalog-item", { itemId: item.id, title: item.name })
      }
      onAddCar={addCar}
      onCheckCar={openCar}
    />
  );
}

function CatalogItem({
  route,
  navigation,
}: NativeStackScreenProps<CatalogStackParams, "catalog-item">) {
  const { completeEngine } = useGarageJump();
  return (
    <ItemScreen
      itemId={route.params.itemId}
      {...(route.params.title ? { title: route.params.title } : {})}
      onBack={navigation.goBack}
      onOpenItem={(item) => navigation.push("catalog-item", { itemId: item.id, title: item.name })}
      onCompleteCar={completeEngine}
    />
  );
}
