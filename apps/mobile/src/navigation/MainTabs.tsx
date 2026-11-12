import { AI_PILOT_ACCESSIBILITY_LABEL, type IconName } from "@adclub/ui-core";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { BottomTabs, type TabItem } from "../design-system";
import { OrdersScreen } from "../screens/tabs/OrdersScreen";
import { useLanguage } from "../state/language";
import { AssistantTab } from "./AssistantStack";
import { AddCarProvider } from "./car-adding";
import { CatalogTab } from "./CatalogStack";
import { GarageStack } from "./GarageStack";
import { ProfileStack } from "./ProfileStack";
import type { TabName, TabParams } from "./routes";

export type { TabName } from "./routes";

/** The tab of the raised button in the middle (SCREENS 3.1, stage D). */
const AI_PILOT_TAB: TabName = "assistant";

const TAB_ICONS: Record<Exclude<TabName, typeof AI_PILOT_TAB>, IconName> = {
  catalog: "category",
  orders: "receipt",
  garage: "car",
  profile: "user",
};

const Tabs = createBottomTabNavigator<TabParams>();

/**
 * The tab bar is the design system's own (DESIGN 7.7): the navigator only
 * says which tab is current, the look comes from `BottomTabs` — four tabs
 * and, in the middle, the raised AI Pilot button (stage D, TASK-063): the
 * circle `primary`, the character idle in the colourway of the theme, the
 * label «AI Pilot» always `accent`, named «AI Pilot, помощник».
 */
function AppTabBar({ state, navigation }: BottomTabBarProps) {
  const { t, lang } = useLanguage();
  const pilot = state.routes.find((route) => route.name === AI_PILOT_TAB);
  const items: TabItem<string>[] = state.routes
    .filter((route) => route.name !== AI_PILOT_TAB)
    .map((route) => ({
      key: route.key,
      label: t(`tabs.${route.name as Exclude<TabName, typeof AI_PILOT_TAB>}`),
      icon: TAB_ICONS[route.name as Exclude<TabName, typeof AI_PILOT_TAB>],
    }));
  const active = state.routes[state.index]?.key ?? items[0]?.key ?? "";

  return (
    <BottomTabs
      items={items}
      active={active}
      {...(pilot
        ? {
            aiPilot: {
              key: pilot.key,
              label: "AI Pilot",
              accessibilityLabel: AI_PILOT_ACCESSIBILITY_LABEL[lang],
            },
          }
        : {})}
      onSelect={(key) => {
        const route = state.routes.find((candidate) => candidate.key === key);
        if (!route) return;
        // The same event the stock tab bar sends: a stack inside the tab
        // listens for it and returns to its first screen when the tab that is
        // already open is pressed again — otherwise the only way back to the
        // top of the catalog would be the arrow, one screen at a time.
        const event = navigation.emit({
          type: "tabPress",
          target: route.key,
          canPreventDefault: true,
        });
        const focused = state.routes[state.index]?.key === key;
        if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
      }}
    />
  );
}

/**
 * The five tabs (Каталог · Заявки · AI Pilot · Гараж · Профиль). A screen
 * of the root stack (`RootNavigator`), which chooses the tab it opens on.
 * Switching tabs is instant — that is how tabs behave — and only what
 * happens inside a tab and above it moves.
 */
export function MainTabs() {
  return (
    // M-GAR-02 (TASK-057): one sheet of the ways to add a car for every tab.
    <AddCarProvider>
      <Tabs.Navigator
        tabBar={(props) => <AppTabBar {...props} />}
        screenOptions={{ headerShown: false, animation: "none" }}
      >
        <Tabs.Screen name="catalog" component={CatalogTab} />
        <Tabs.Screen name="orders" component={OrdersScreen} />
        <Tabs.Screen name="assistant" component={AssistantTab} />
        <Tabs.Screen name="garage" component={GarageStack} />
        <Tabs.Screen name="profile" component={ProfileStack} />
      </Tabs.Navigator>
    </AddCarProvider>
  );
}
