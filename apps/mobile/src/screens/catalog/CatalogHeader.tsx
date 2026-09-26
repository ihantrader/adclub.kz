import { layout } from "@adclub/ui-core";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Chip } from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { carTitle } from "../../garage/garage";
import { cityLabel } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useT } from "../../state/language";
import { CitySheet } from "../CitySheet";
import { CarSheet } from "./CarSheet";

/**
 * The header of the catalog (M-CAT-01, M-CAT-02): the car switch — the cars
 * of the garage and «Добавить автомобиль» — and the city switch. One
 * component, so both screens switch the same way. There is always a car: the
 * catalog does not open without one (D-062).
 */
export function CatalogHeader({ onAddCar }: { onAddCar: () => void }) {
  const t = useT();
  const { selection } = useCity();
  const { car, chooseCar } = useCatalogCar();
  const [sheet, setSheet] = useState<"car" | "city" | null>(null);

  return (
    <View style={styles.header}>
      <Chip icon="car" onPress={() => setSheet("car")}>
        {carTitle(car)}
      </Chip>
      <Chip icon="mapPin" onPress={() => setSheet("city")}>
        {cityLabel(selection, t("city.all"))}
      </Chip>

      <CarSheet
        visible={sheet === "car"}
        onClose={() => setSheet(null)}
        onPickCar={chooseCar}
        onAddCar={onAddCar}
      />
      <CitySheet visible={sheet === "city"} onClose={() => setSheet(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: layout.screenPadding,
    paddingTop: 4,
    paddingBottom: 8,
  },
});
