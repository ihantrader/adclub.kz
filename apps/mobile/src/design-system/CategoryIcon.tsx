import type { CategoryIcon as CategoryIconName } from "@adclub/contracts";
import { icon as iconTokens, type ColorToken } from "@adclub/ui-core";
import IconAirConditioning from "@tabler/icons-react-native/IconAirConditioning";
import IconArmchair from "@tabler/icons-react-native/IconArmchair";
import IconBatteryAutomotive from "@tabler/icons-react-native/IconBatteryAutomotive";
import IconBolt from "@tabler/icons-react-native/IconBolt";
import IconBucketDroplet from "@tabler/icons-react-native/IconBucketDroplet";
import IconBulb from "@tabler/icons-react-native/IconBulb";
import IconCar from "@tabler/icons-react-native/IconCar";
import IconCarDoor from "@tabler/icons-react-native/IconCarDoor";
import IconCarFan from "@tabler/icons-react-native/IconCarFan";
import IconCarGarage from "@tabler/icons-react-native/IconCarGarage";
import IconCarLifter from "@tabler/icons-react-native/IconCarLifter";
import IconCarSuspension from "@tabler/icons-react-native/IconCarSuspension";
import IconCarTurbine from "@tabler/icons-react-native/IconCarTurbine";
import IconCategory from "@tabler/icons-react-native/IconCategory";
import IconDisc from "@tabler/icons-react-native/IconDisc";
import IconDroplet from "@tabler/icons-react-native/IconDroplet";
import IconEngine from "@tabler/icons-react-native/IconEngine";
import IconFilter from "@tabler/icons-react-native/IconFilter";
import IconFlask from "@tabler/icons-react-native/IconFlask";
import IconGasStation from "@tabler/icons-react-native/IconGasStation";
import IconGauge from "@tabler/icons-react-native/IconGauge";
import IconKey from "@tabler/icons-react-native/IconKey";
import IconLamp from "@tabler/icons-react-native/IconLamp";
import IconManualGearbox from "@tabler/icons-react-native/IconManualGearbox";
import IconPackage from "@tabler/icons-react-native/IconPackage";
import IconPaint from "@tabler/icons-react-native/IconPaint";
import IconPlug from "@tabler/icons-react-native/IconPlug";
import IconRoad from "@tabler/icons-react-native/IconRoad";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import IconShield from "@tabler/icons-react-native/IconShield";
import IconSnowflake from "@tabler/icons-react-native/IconSnowflake";
import IconSpray from "@tabler/icons-react-native/IconSpray";
import IconSteeringWheel from "@tabler/icons-react-native/IconSteeringWheel";
import IconTag from "@tabler/icons-react-native/IconTag";
import IconTemperature from "@tabler/icons-react-native/IconTemperature";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconTools from "@tabler/icons-react-native/IconTools";
import IconTruck from "@tabler/icons-react-native/IconTruck";
import IconWash from "@tabler/icons-react-native/IconWash";
import IconWheel from "@tabler/icons-react-native/IconWheel";
import IconWiper from "@tabler/icons-react-native/IconWiper";
import IconWiperWash from "@tabler/icons-react-native/IconWiperWash";
import { useTheme } from "./theme";

// One module per icon (package subpaths), like `Icon`: Metro does not
// tree-shake, and the package index would pull all ~5 000 icons in.
export const categoryIconComponents = {
  "air-conditioning": IconAirConditioning,
  armchair: IconArmchair,
  "battery-automotive": IconBatteryAutomotive,
  bolt: IconBolt,
  "bucket-droplet": IconBucketDroplet,
  bulb: IconBulb,
  car: IconCar,
  "car-door": IconCarDoor,
  "car-fan": IconCarFan,
  "car-garage": IconCarGarage,
  "car-lifter": IconCarLifter,
  "car-suspension": IconCarSuspension,
  "car-turbine": IconCarTurbine,
  category: IconCategory,
  disc: IconDisc,
  droplet: IconDroplet,
  engine: IconEngine,
  filter: IconFilter,
  flask: IconFlask,
  "gas-station": IconGasStation,
  gauge: IconGauge,
  key: IconKey,
  lamp: IconLamp,
  "manual-gearbox": IconManualGearbox,
  package: IconPackage,
  paint: IconPaint,
  plug: IconPlug,
  road: IconRoad,
  settings: IconSettings,
  shield: IconShield,
  snowflake: IconSnowflake,
  spray: IconSpray,
  "steering-wheel": IconSteeringWheel,
  tag: IconTag,
  temperature: IconTemperature,
  tool: IconTool,
  tools: IconTools,
  truck: IconTruck,
  wash: IconWash,
  wheel: IconWheel,
  wiper: IconWiper,
  "wiper-wash": IconWiperWash,
} satisfies Record<CategoryIconName, unknown>;

export interface CategoryIconProps {
  /** The icon an administrator gave the category; `null` — the generic one. */
  name: CategoryIconName | null;
  size?: 20 | 24 | 28 | 32 | 48;
  color?: ColorToken;
}

/**
 * The icon of a catalog category (`categoryIcons` of the contract): the
 * tiles of M-CAT-01 and the placeholder of an item without a photo
 * (DESIGN 7.8). Decorative — the name of the category is always next to it.
 */
export function CategoryIcon({ name, size = 24, color = "text" }: CategoryIconProps) {
  const { theme } = useTheme();
  const Component = name ? categoryIconComponents[name] : IconCategory;
  return (
    <Component
      size={size}
      color={theme.colors[color]}
      strokeWidth={iconTokens.strokeWidth}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    />
  );
}
