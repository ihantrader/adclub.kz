import type { IconName } from "@adclub/ui-core";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { NavigationContainer, type Theme as NavigationTheme } from "@react-navigation/native";
import { useMemo } from "react";
import { CatalogCarProvider } from "../catalog/catalog-car-provider";
import { BottomTabs, useTheme, type TabItem } from "../design-system";
import { OrdersScreen } from "../screens/tabs/OrdersScreen";
import { ProfileScreen } from "../screens/tabs/ProfileScreen";
import { useT } from "../state/language";
import { CatalogStack } from "./CatalogStack";
import { GarageStack } from "./GarageStack";
import type { TabName, TabParams } from "./routes";

export type { TabName } from "./routes";

const TAB_ICONS: Record<TabName, IconName> = {
  catalog: "category",
  orders: "receipt",
  garage: "car",
  profile: "user",
};

const Tabs = createBottomTabNavigator<TabParams>();

/**
 * The tab bar is the design system's own (DESIGN 7.7): the navigator only
 * says which tab is current, the look comes from `BottomTabs`. The raised
 * AI Pilot button in the middle is left out until stage D — until then the
 * bar has four tabs, exactly as the mockups say.
 */
function AppTabBar({ state, navigation }: BottomTabBarProps) {
  const t = useT();
  const items: TabItem<string>[] = state.routes.map((route) => ({
    key: route.key,
    label: t(`tabs.${route.name as TabName}`),
    icon: TAB_ICONS[route.name as TabName],
  }));
  const active = state.routes[state.index]?.key ?? items[0]?.key ?? "";

  return (
    <BottomTabs
      items={items}
      active={active}
      onSelect={(key) => {
        const route = state.routes.find((candidate) => candidate.key === key);
        if (route) navigation.navigate(route.name);
      }}
    />
  );
}

export interface MainTabsProps {
  /** The tab the app opens on (the start decision of SCREENS 5.1). */
  initialTab?: TabName;
}

export function MainTabs({ initialTab = "catalog" }: MainTabsProps) {
  const { theme } = useTheme();

  // The navigator's own theme only keeps the colours behind screens right:
  // the visible chrome is the design system's.
  const navigationTheme = useMemo<NavigationTheme>(
    () => ({
      dark: theme.name === "dark",
      colors: {
        primary: theme.colors.accent,
        background: theme.colors.bg,
        card: theme.colors.bar,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.danger,
      },
      fonts: DEFAULT_FONTS,
    }),
    [theme],
  );

  return (
    <NavigationContainer theme={navigationTheme}>
      {/* «Показать без фильтра» is a state of the catalog, not of the garage. */}
      <CatalogCarProvider>
        <Tabs.Navigator
          initialRouteName={initialTab}
          tabBar={(props) => <AppTabBar {...props} />}
          screenOptions={{ headerShown: false, animation: "none" }}
        >
          <Tabs.Screen name="catalog" component={CatalogStack} />
          <Tabs.Screen name="orders" component={OrdersScreen} />
          <Tabs.Screen name="garage" component={GarageStack} />
          <Tabs.Screen name="profile" component={ProfileScreen} />
        </Tabs.Navigator>
      </CatalogCarProvider>
    </NavigationContainer>
  );
}

/**
 * React Navigation asks for font styles for its own headers and titles;
 * the app draws none of them (`headerShown: false`, own tab bar), so the
 * platform defaults are enough here — screen text uses `Text` of the design
 * system with Onest.
 */
const DEFAULT_FONTS: NavigationTheme["fonts"] = {
  regular: { fontFamily: "System", fontWeight: "400" },
  medium: { fontFamily: "System", fontWeight: "500" },
  bold: { fontFamily: "System", fontWeight: "700" },
  heavy: { fontFamily: "System", fontWeight: "700" },
};
