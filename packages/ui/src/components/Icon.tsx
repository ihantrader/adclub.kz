import { icon as iconTokens, type IconName } from "@adclub/ui-core";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowLeft,
  IconBackspace,
  IconCar,
  IconCategory,
  IconCheck,
  IconChecklist,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconCopy,
  IconDots,
  IconFileSpreadsheet,
  IconHelpCircle,
  IconInfoCircle,
  IconLock,
  IconMinus,
  IconMoon,
  IconPackage,
  IconPlus,
  IconProgressCheck,
  IconReceipt,
  IconRefresh,
  IconScan,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconStar,
  IconSun,
  IconTags,
  IconTrash,
  IconUser,
  IconWifiOff,
  IconX,
  type Icon as TablerIcon,
} from "@tabler/icons-react";

/** Tabler Icons (outline) behind the shared semantic names (DESIGN.md 7.6). */
export const icons: Record<IconName, TablerIcon> = {
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
};

export type IconSize = 16 | 20 | 24 | 28 | 48;

export interface IconProps {
  name: IconName;
  /** 16 · 20 · 24; 48 — empty states and outcomes. */
  size?: IconSize;
  className?: string;
  /** Decorative by default; pass a label only when the icon alone carries meaning. */
  label?: string;
  filled?: boolean;
}

export function Icon({ name, size = 20, className, label, filled }: IconProps) {
  const Component = icons[name];
  return (
    <Component
      size={size}
      stroke={iconTokens.strokeWidth}
      className={className ? `ac-icon ${className}` : "ac-icon"}
      fill={filled ? "currentColor" : "none"}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}
