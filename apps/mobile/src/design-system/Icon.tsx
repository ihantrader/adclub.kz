import { icon as iconTokens, type ColorToken, type IconName } from "@adclub/ui-core";
import IconAlertTriangle from "@tabler/icons-react-native/IconAlertTriangle";
import IconArchive from "@tabler/icons-react-native/IconArchive";
import IconArrowLeft from "@tabler/icons-react-native/IconArrowLeft";
import IconBackspace from "@tabler/icons-react-native/IconBackspace";
// The car glyph (TASK-028.B, requirement 2): an SUV silhouette reads as more
// distinctive than the generic `IconCar` used until this task, and it fits
// the club's own cars (Geely Atlas, Monjaro — SUVs). Two more candidates
// (`IconCar4wd`, `IconSteeringWheel`) sit next to this one in the dev
// showcase ("Значок автомобиля") for the Product Owner to compare; swapping
// the pick is exactly this one import and the one line below it, because
// every place that shows "the car icon" asks for it by the same name, `car`.
import IconCar from "@tabler/icons-react-native/IconCarSuv";
import IconCategory from "@tabler/icons-react-native/IconCategory";
import IconCheck from "@tabler/icons-react-native/IconCheck";
import IconChecklist from "@tabler/icons-react-native/IconChecklist";
import IconChevronDown from "@tabler/icons-react-native/IconChevronDown";
import IconChevronRight from "@tabler/icons-react-native/IconChevronRight";
import IconCircleCheck from "@tabler/icons-react-native/IconCircleCheck";
import IconCircleX from "@tabler/icons-react-native/IconCircleX";
import IconClock from "@tabler/icons-react-native/IconClock";
import IconContrast from "@tabler/icons-react-native/IconContrast";
import IconCopy from "@tabler/icons-react-native/IconCopy";
import IconDevices from "@tabler/icons-react-native/IconDevices";
import IconDots from "@tabler/icons-react-native/IconDots";
import IconFileSpreadsheet from "@tabler/icons-react-native/IconFileSpreadsheet";
import IconHelpCircle from "@tabler/icons-react-native/IconHelpCircle";
import IconInfoCircle from "@tabler/icons-react-native/IconInfoCircle";
import IconLanguage from "@tabler/icons-react-native/IconLanguage";
import IconLock from "@tabler/icons-react-native/IconLock";
import IconLogout from "@tabler/icons-react-native/IconLogout";
import IconMapPin from "@tabler/icons-react-native/IconMapPin";
import IconMinus from "@tabler/icons-react-native/IconMinus";
import IconMoon from "@tabler/icons-react-native/IconMoon";
import IconCurrentLocation from "@tabler/icons-react-native/IconCurrentLocation";
import IconPackage from "@tabler/icons-react-native/IconPackage";
import IconPlus from "@tabler/icons-react-native/IconPlus";
import IconProgressCheck from "@tabler/icons-react-native/IconProgressCheck";
import IconReceipt from "@tabler/icons-react-native/IconReceipt";
import IconRefresh from "@tabler/icons-react-native/IconRefresh";
import IconScan from "@tabler/icons-react-native/IconScan";
import IconSearch from "@tabler/icons-react-native/IconSearch";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconStar from "@tabler/icons-react-native/IconStar";
import IconSun from "@tabler/icons-react-native/IconSun";
import IconTags from "@tabler/icons-react-native/IconTags";
import IconTrash from "@tabler/icons-react-native/IconTrash";
import IconUser from "@tabler/icons-react-native/IconUser";
import IconWifiOff from "@tabler/icons-react-native/IconWifiOff";
import IconX from "@tabler/icons-react-native/IconX";
import { useTheme } from "./theme";

// One module per icon (package subpaths): Metro does not tree-shake, and the
// package index would pull all ~5 000 icons into the bundle.
export const icons = {
  alertTriangle: IconAlertTriangle,
  archive: IconArchive,
  arrowLeft: IconArrowLeft,
  backspace: IconBackspace,
  car: IconCar,
  category: IconCategory,
  check: IconCheck,
  checklist: IconChecklist,
  chevronDown: IconChevronDown,
  chevronRight: IconChevronRight,
  circleCheck: IconCircleCheck,
  circleX: IconCircleX,
  clock: IconClock,
  contrast: IconContrast,
  copy: IconCopy,
  devices: IconDevices,
  dots: IconDots,
  fileSpreadsheet: IconFileSpreadsheet,
  helpCircle: IconHelpCircle,
  info: IconInfoCircle,
  language: IconLanguage,
  lock: IconLock,
  logout: IconLogout,
  mapPin: IconMapPin,
  minus: IconMinus,
  moon: IconMoon,
  myLocation: IconCurrentLocation,
  package: IconPackage,
  plus: IconPlus,
  progressCheck: IconProgressCheck,
  receipt: IconReceipt,
  refresh: IconRefresh,
  scan: IconScan,
  search: IconSearch,
  settings: IconSettings,
  sparkles: IconSparkles,
  star: IconStar,
  sun: IconSun,
  tags: IconTags,
  trash: IconTrash,
  user: IconUser,
  wifiOff: IconWifiOff,
  x: IconX,
} satisfies Record<IconName, unknown>;

export interface IconProps {
  name: IconName;
  size?: 16 | 20 | 24 | 28 | 48;
  color?: ColorToken;
  /** Explicit color (e.g. on the white code screen). */
  colorValue?: string;
  filled?: boolean;
}

/** Tabler outline icon, stroke 1.75 (DESIGN.md 7.6); decorative for screen readers. */
export function Icon({ name, size = 20, color = "text", colorValue, filled }: IconProps) {
  const { theme } = useTheme();
  const Component = icons[name];
  const stroke = colorValue ?? theme.colors[color];
  return (
    <Component
      size={size}
      color={stroke}
      strokeWidth={iconTokens.strokeWidth}
      fill={filled ? stroke : "none"}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    />
  );
}
