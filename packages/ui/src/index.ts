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
export { cx } from "./components/cx";
export { ActionBar, type ActionBarProps } from "./components/ActionBar";
export { MenuButton, type MenuAction, type MenuButtonProps } from "./components/MenuButton";
export { DateField, type DateFieldProps, type DateFieldTexts } from "./components/DateField";
export {
  addDays,
  addMonths,
  dateTextOf,
  maskAfterDelete,
  maskDateText,
  monthWeeks,
  moveDay,
  readDateText,
  type DateTextReading,
} from "./components/date-field-core";
export { SearchSelect } from "./components/SearchSelect";
export type { SearchSelectProps, SearchSelectTexts } from "./components/SearchSelect";
export {
  createText,
  firstActive,
  isMoveKey,
  listed,
  moveActive,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_CHARS,
  SEARCH_PAGE,
  searchQuery,
} from "./components/search-select-core";
export type { Choice, ChoiceSource, MoveKey } from "./components/search-select-core";
export {
  CodeCells,
  Keypad,
  SearchField,
  SelectField,
  TextAreaField,
  TextField,
  useKeyboardFocus,
  type CodeCellsProps,
  type KeypadProps,
  type SearchFieldProps,
  type SelectFieldProps,
  type SelectOption,
  type TextAreaFieldProps,
  type TextFieldProps,
} from "./components/fields";
export {
  Checkbox,
  Chip,
  ChipRow,
  FilterSelect,
  Quantity,
  Radio,
  Segments,
  Switch,
  type CheckboxProps,
  type ChipProps,
  type FilterSelectProps,
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
  TypeMark,
  type BadgeProps,
  type RatingProps,
  type TypeMarkProps,
} from "./components/marks";
export {
  Banner,
  Dialog,
  EmptyState,
  ScreenError,
  Skeleton,
  SkeletonList,
  ToastProvider,
  toastArea,
  toastObstacle,
  toastRegionStyle,
  useToast,
  type BannerProps,
  type ToastAction,
  type DialogProps,
  type EmptyStateProps,
  type ScreenErrorProps,
} from "./components/feedback";
export {
  DelayedSkeleton,
  FadeSwap,
  LoadingContent,
  RefreshLine,
  useContentSwap,
  useDelayedIndicator,
  useLoadingGate,
  useReducedMotion,
  type LoadingContentProps,
  type LoadingGateHandle,
} from "./components/loading";
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
  ClosedDatesEditor,
  WeekHoursEditor,
  type ClosedDatesEditorProps,
  type ClosedDatesTexts,
  type WeekHoursEditorProps,
  type WeekHoursTexts,
} from "./components/schedule";
export {
  closedDateProblem,
  copyToWeekdays,
  dayHoursText,
  dayIntervals,
  todayIn,
  upcomingClosedDates,
  weekFormOf,
  weeklyHoursOf,
  type ClosedDate as ScheduleClosedDate,
  type ClosedDateProblem,
  type DayForm,
  type DayMode,
  type WeekForm,
  type WeekResult,
} from "./components/schedule-form";
export {
  BottomTabs,
  Logo,
  Sidebar,
  type BottomTabsProps,
  type LogoProps,
  type NavItem,
  type SidebarProps,
} from "./components/navigation";
