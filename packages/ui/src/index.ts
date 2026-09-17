/**
 * Web design system of the supplier cabinet and the admin panel (TASK-075,
 * ARCHITECTURE 3.5, 4.10). Importing the package loads the fonts, the theme
 * custom properties and the component styles. Tokens and component logic
 * are imported from `@adclub/ui-core` directly: it is a CommonJS package,
 * and `export *` from it breaks under the Vite dev server.
 */
import "./styles/fonts.css";
import "./styles/theme.css";
import "./styles/components.css";

export { browserThemeStorage, ThemeProvider, useTheme } from "./theme/ThemeProvider";
export type { ThemeContextValue, ThemeProviderProps } from "./theme/ThemeProvider";
export { colorVar, kebab, typographyClass } from "./theme/theme-css";
export { Icon, icons, type IconProps, type IconSize } from "./components/Icon";
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonProps,
} from "./components/Button";
export { Spinner } from "./components/Spinner";
export {
  CodeCells,
  Keypad,
  SearchField,
  TextField,
  type CodeCellsProps,
  type KeypadProps,
  type SearchFieldProps,
  type TextFieldProps,
} from "./components/fields";
export {
  Checkbox,
  Chip,
  Quantity,
  Radio,
  Segments,
  Switch,
  type CheckboxProps,
  type ChipProps,
  type QuantityProps,
  type RadioProps,
  type SegmentOption,
  type SegmentsProps,
  type SwitchProps,
} from "./components/controls";
export {
  AiBadge,
  Badge,
  CompatibilityMark,
  Rating,
  StatusBadge,
  type BadgeProps,
  type RatingProps,
} from "./components/marks";
export {
  Banner,
  Dialog,
  EmptyState,
  ScreenError,
  Skeleton,
  SkeletonList,
  ToastProvider,
  useToast,
  type BannerProps,
  type DialogProps,
  type EmptyStateProps,
  type ScreenErrorProps,
} from "./components/feedback";
export {
  CodeBlock,
  DataTable,
  QrCode,
  type CodeBlockProps,
  type DataTableProps,
  type QrCodeProps,
  type TableCell,
  type TableColumn,
  type TableRow,
} from "./components/data";
export {
  BottomTabs,
  Logo,
  Sidebar,
  type BottomTabsProps,
  type LogoProps,
  type NavItem,
  type SidebarProps,
} from "./components/navigation";
