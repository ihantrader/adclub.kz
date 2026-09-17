import { icon as iconTokens, type ColorToken, type IconName } from "@adclub/ui-core";
import IconAlertTriangle from "@tabler/icons-react-native/IconAlertTriangle";
import IconArchive from "@tabler/icons-react-native/IconArchive";
import IconArrowLeft from "@tabler/icons-react-native/IconArrowLeft";
import IconBackspace from "@tabler/icons-react-native/IconBackspace";
import IconCar from "@tabler/icons-react-native/IconCar";
import IconCategory from "@tabler/icons-react-native/IconCategory";
import IconCheck from "@tabler/icons-react-native/IconCheck";
import IconChecklist from "@tabler/icons-react-native/IconChecklist";
import IconChevronRight from "@tabler/icons-react-native/IconChevronRight";
import IconCircleCheck from "@tabler/icons-react-native/IconCircleCheck";
import IconCircleX from "@tabler/icons-react-native/IconCircleX";
import IconClock from "@tabler/icons-react-native/IconClock";
import IconCopy from "@tabler/icons-react-native/IconCopy";
import IconDots from "@tabler/icons-react-native/IconDots";
import IconFileSpreadsheet from "@tabler/icons-react-native/IconFileSpreadsheet";
import IconHelpCircle from "@tabler/icons-react-native/IconHelpCircle";
import IconInfoCircle from "@tabler/icons-react-native/IconInfoCircle";
import IconLock from "@tabler/icons-react-native/IconLock";
import IconMinus from "@tabler/icons-react-native/IconMinus";
import IconMoon from "@tabler/icons-react-native/IconMoon";
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
  chevronRight: IconChevronRight,
  circleCheck: IconCircleCheck,
  circleX: IconCircleX,
  clock: IconClock,
  copy: IconCopy,
  dots: IconDots,
  fileSpreadsheet: IconFileSpreadsheet,
  helpCircle: IconHelpCircle,
  info: IconInfoCircle,
  lock: IconLock,
  minus: IconMinus,
  moon: IconMoon,
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
