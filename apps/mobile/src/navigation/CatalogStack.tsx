import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback } from "react";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { CatalogHomeScreen } from "../screens/catalog/CatalogHomeScreen";
import { ItemListScreen } from "../screens/catalog/ItemListScreen";
import { ItemScreen } from "../screens/catalog/ItemScreen";
import { SubcategoriesScreen } from "../screens/catalog/SubcategoriesScreen";
import type { CatalogStackParams, TabParams } from "./routes";

const Stack = createNativeStackNavigator<CatalogStackParams>();

/** The catalog tab: main screen → subcategories → items → item card. */
export function CatalogStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="catalog-home" component={CatalogHome} />
      <Stack.Screen name="catalog-node" component={CatalogNode} />
      <Stack.Screen name="catalog-items" component={CatalogItems} />
      <Stack.Screen name="catalog-item" component={CatalogItem} />
    </Stack.Navigator>
  );
}

/**
 * The garage is a tab of its own, so «Добавить автомобиль» and «Дополнить»
 * from the catalog jump there instead of opening a second copy of the same
 * screens.
 */
function useGarageJump() {
  const tabs = useNavigation<BottomTabNavigationProp<TabParams>>();
  const addCar = useCallback(
    () => tabs.navigate("garage", { screen: "garage-picker", params: {} }),
    [tabs],
  );
  const openCar = useCallback(
    (carId: string) => tabs.navigate("garage", { screen: "garage-car", params: { carId } }),
    [tabs],
  );
  const completeEngine = useCallback(
    (carId: string) =>
      tabs.navigate("garage", { screen: "garage-picker", params: { carId, step: "engine" } }),
    [tabs],
  );
  return { addCar, openCar, completeEngine };
}

function CatalogHome({ navigation }: NativeStackScreenProps<CatalogStackParams, "catalog-home">) {
  const { addCar, completeEngine } = useGarageJump();
  return (
    <CatalogHomeScreen
      onOpenNode={(node) => navigation.navigate("catalog-node", { categoryId: node.id })}
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
      onBack={navigation.goBack}
      onOpen={(subcategory) => navigation.navigate("catalog-items", { categoryId: subcategory.id })}
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
      onBack={navigation.goBack}
      onOpenItem={(itemId) => navigation.navigate("catalog-item", { itemId })}
      onAddCar={addCar}
      onCheckCar={openCar}
    />
  );
}

function CatalogItem({
  route,
  navigation,
}: NativeStackScreenProps<CatalogStackParams, "catalog-item">) {
  const { addCar, completeEngine } = useGarageJump();
  return (
    <ItemScreen
      itemId={route.params.itemId}
      onBack={navigation.goBack}
      onOpenItem={(itemId) => navigation.push("catalog-item", { itemId })}
      onAddCar={addCar}
      onCompleteCar={completeEngine}
    />
  );
}
