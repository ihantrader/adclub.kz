import {
  bannerTones,
  floatShadow,
  layout,
  motion,
  radius,
  sheetMotion,
  size,
  TOAST_GAP,
  toastBottomOffset,
  type BannerTone,
  type IconName,
} from "@adclub/ui-core";
import { NavigationContext } from "@react-navigation/native";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type DimensionValue,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { hairline } from "./lines";
import { animateTo, useMotionPlan, useOverlayTransition } from "./motion";
import { Text } from "./text";
import { useTheme } from "./theme";

const bannerIcons: Record<BannerTone, IconName> = {
  neutral: "info",
  warning: "alertTriangle",
  danger: "circleX",
};

export interface BannerProps {
  tone?: BannerTone;
  icon?: IconName;
  /** Inline — radius 6; flush — under a bar, no radius. */
  placement?: "inline" | "flush";
  action?: ReactNode;
  children: ReactNode;
}

export function Banner({
  tone = "neutral",
  icon,
  placement = "inline",
  action,
  children,
}: BannerProps) {
  const { theme } = useTheme();
  const colors = bannerTones[tone];
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : "summary"}
      style={[
        styles.banner,
        { backgroundColor: theme.colors[colors.background] },
        placement === "inline" && { borderRadius: radius.m },
      ]}
    >
      <Icon name={icon ?? bannerIcons[tone]} size={20} color={colors.icon} />
      <View style={styles.bannerBody}>
        <Text variant="bodyS">{children}</Text>
        {action}
      </View>
    </View>
  );
}

const ToastContext = createContext<{ show: (message: string) => void } | null>(null);

function floatStyle(name: "dark" | "light"): ViewStyle {
  const shadow = floatShadow[name];
  if (!shadow) return {};
  return { boxShadow: shadow.css };
}

/**
 * Keeps showing what an overlay showed while it was open, for as long as it
 * is going away. What is behind a closing sheet or dialog is usually the
 * state that closed it — the language just chosen, the level just cleared —
 * and an overlay that redrew itself with it would change under the eyes
 * while it slides or fades out. Only the props are held: a component inside
 * still follows its own context.
 */
const Held = memo(
  function Held({ children }: { children: ReactNode; hold: boolean }) {
    return <>{children}</>;
  },
  (_previous, next) => next.hold,
);

/** Reports the top edge (in the window) of a pinned element, `null` — gone or off screen. */
type RegisterObstacle = (id: number, top: number | null) => void;

const ToastObstacleContext = createContext<RegisterObstacle | null>(null);

let nextObstacleId = 0;

/**
 * Marks a view pinned to the bottom that a toast must stand above (DESIGN
 * 7.7, TASK-032): the tab bar, the pinned main button of a screen. Spread
 * the result onto the view. Only while its screen is the focused one — the
 * tab bar under a step of choosing a car, or the footer of a screen left
 * behind in a stack, is not on screen and must not lift the toast.
 */
export function useToastObstacle(): {
  ref: RefObject<View | null>;
  onLayout: () => void;
} {
  const register = useContext(ToastObstacleContext);
  const navigation = useContext(NavigationContext);
  const [id] = useState(() => ++nextObstacleId);
  const ref = useRef<View>(null);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);

  useEffect(() => {
    if (!navigation) return;
    const offFocus = navigation.addListener("focus", () => setFocused(true));
    const offBlur = navigation.addListener("blur", () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);

  const onLayout = useCallback(() => {
    if (!register) return;
    if (!focused) {
      register(id, null);
      return;
    }
    ref.current?.measureInWindow((_x, y, width, height) =>
      register(id, width > 0 && height > 0 ? y : null),
    );
  }, [register, focused, id]);

  useEffect(() => {
    onLayout();
  }, [onLayout]);
  useEffect(() => () => register?.(id, null), [register, id]);

  return { ref, onLayout };
}

/**
 * Confirmations only ("Код скопирован"), 4 s; errors stay in the screen
 * (7.7). The toast stands 8 above the tab bar or the pinned main button of
 * the focused screen (`useToastObstacle`), and above the safe area when
 * there is neither — never on the navigation or the main action.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; visible: boolean }>({
    text: "",
    visible: false,
  });
  const [obstacles, setObstacles] = useState<ReadonlyMap<number, number>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    setToast({ text, visible: true });
    AccessibilityInfo.announceForAccessibility(text);
    // The text stays while the toast fades out: only `visible` goes down.
    timer.current = setTimeout(
      () => setToast((current) => ({ ...current, visible: false })),
      motion.toast,
    );
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const register = useCallback<RegisterObstacle>((id, top) => {
    setObstacles((current) => {
      if (top === null ? !current.has(id) : current.get(id) === top) return current;
      const next = new Map(current);
      if (top === null) next.delete(id);
      else next.set(id, top);
      return next;
    });
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      <ToastObstacleContext.Provider value={register}>{children}</ToastObstacleContext.Provider>
      <ToastView text={toast.text} visible={toast.visible} pinnedTops={[...obstacles.values()]} />
    </ToastContext.Provider>
  );
}

/** The toast itself: it fades in and out over 150 ms (DESIGN 7.6) — opacity alone, so also with reduced motion. */
function ToastView({
  text,
  visible,
  pinnedTops,
}: {
  text: string;
  visible: boolean;
  pinnedTops: readonly number[];
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const plan = useMotionPlan("appear");
  const { progress, mounted } = useOverlayTransition(visible, plan);
  if (!mounted) return null;
  const bottom = Math.max(
    toastBottomOffset(viewport.height, pinnedTops) ?? 0,
    insets.bottom + TOAST_GAP,
  );
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[
        styles.toast,
        { bottom, backgroundColor: theme.colors.toast, opacity: progress },
        floatStyle(theme.name),
      ]}
    >
      <Icon name="circleCheck" size={20} colorValue={theme.colors.onToast} />
      <Text variant="bodyS" style={[styles.flex, { color: theme.colors.onToast }]}>
        {text}
      </Text>
    </Animated.View>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside <ToastProvider>");
  return value;
}

/** Skeleton block: surfaceRaised, radius 2, 1.2 s shimmer — none with "reduce motion". */
export function Skeleton({
  width = "100%",
  height = 16,
  rounded,
}: {
  width?: DimensionValue;
  height?: number;
  rounded?: boolean;
}) {
  const { theme, reduceMotion } = useTheme();
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const half = motion.skeleton / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.55, duration: half, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: half, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduceMotion]);
  return (
    <Animated.View
      style={{
        width,
        height,
        opacity,
        borderRadius: rounded ? radius.m : radius.xs,
        backgroundColor: theme.colors.surfaceRaised,
      }}
    />
  );
}

/** Skeleton of list rows repeating the real layout. */
export function SkeletonList({ rows = 3, label }: { rows?: number; label: string }) {
  const { theme } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={[styles.list, { backgroundColor: theme.colors.surface }]}
    >
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          style={[
            styles.skeletonRow,
            index > 0 && { borderTopWidth: hairline, borderTopColor: theme.colors.border },
          ]}
        >
          <Skeleton width={size.thumbnail} height={size.thumbnail} rounded />
          <View style={styles.skeletonLines}>
            <Skeleton width="85%" />
            <Skeleton width="50%" height={12} />
            <Skeleton width="35%" height={20} />
          </View>
        </View>
      ))}
    </View>
  );
}

export interface EmptyStateProps {
  icon: IconName;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
}

/** Icon 48, heading, muted text, one button (SCREENS 2.2). */
export function EmptyState({ icon, title, text, action }: EmptyStateProps) {
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={48} color="textMuted" />
      <Text variant="heading" style={styles.center} accessibilityRole="header">
        {title}
      </Text>
      {text && (
        <Text variant="bodyS" color="textMuted" style={styles.center}>
          {text}
        </Text>
      )}
      {action && <View style={styles.emptyAction}>{action}</View>}
    </View>
  );
}

export function ScreenError({
  title,
  text,
  retry,
}: {
  title: ReactNode;
  text?: ReactNode;
  retry?: { label: string; onRetry: () => unknown };
}) {
  return (
    <View accessibilityRole="alert">
      <EmptyState
        icon="alertTriangle"
        title={title}
        text={text}
        action={
          retry && (
            <Button variant="secondary" size="m" icon="refresh" onPress={retry.onRetry}>
              {retry.label}
            </Button>
          )
        }
      />
    </View>
  );
}

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Screen reader name of the dimmed background that closes the sheet. */
  closeLabel: string;
  /** A required action: no closing by swipe or tapping the scrim. */
  required?: boolean;
  /**
   * Called once when the sheet has finished going away. An action that
   * belongs to closing it — going to another screen, deleting what was
   * chosen — waits for this (`useAfterDismiss`) instead of running while the
   * sheet is still sliding down.
   */
  onDismissed?: () => void;
  children: ReactNode;
}

/**
 * Bottom sheet: surface, radius 12 on top, handle 36 × 4, padding 16, scrim
 * below (DESIGN 7.7).
 *
 * The motion is the rule's (`sheetMotion`, DESIGN 7.6) and not the
 * platform's: `Modal animationType="slide"` moves the **whole** window, so
 * the scrim travelled up from the bottom edge together with the sheet. Here
 * the scrim is what it is meant to be — a layer under the sheet that only
 * changes opacity — while the sheet slides up over 250 ms with deceleration
 * at the end. With "reduce motion" nothing moves: both only fade. Closing
 * plays the same animation backwards, and the modal stays mounted until it
 * has finished, so there is no jump; what the sheet shows stays as it was
 * while it goes (`Held`), and a swipe down continues from where the finger
 * let go.
 */
export function Sheet({
  visible,
  onClose,
  onDismissed,
  title,
  closeLabel,
  required,
  children,
}: SheetProps) {
  const { theme, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const rule = sheetMotion(reduceMotion);
  const plan = useMotionPlan("sheet");
  // 0 — closed, 1 — open: the scrim's opacity and how far the sheet has travelled.
  const { progress, mounted } = useOverlayTransition(visible, plan, onDismissed);
  const [drag] = useState(() => new Animated.Value(0));
  /** The sheet's own height: that is all it has to travel. */
  const [height, setHeight] = useState(0);

  // A sheet that opens starts where it belongs. Only opening resets it: on
  // closing the sheet may have been swiped down, and putting it back before
  // it leaves would be a jump up in front of the finger.
  useEffect(() => {
    if (visible) drag.setValue(0);
  }, [visible, drag]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => !required && gesture.dy > 6,
        onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > 80 || gesture.vy > 0.8) {
            onClose();
            return;
          }
          // Not far enough to close: back to its place — the same movement
          // as the sheet's own, and nothing that slides when motion is reduced.
          if (plan.moves) animateTo(drag, 0, plan).start();
          else drag.setValue(0);
        },
      }),
    [drag, onClose, required, plan],
  );

  // Until the sheet is measured the window height keeps it off screen, so
  // nothing flashes on the first frame.
  const travel = height > 0 ? height : Dimensions.get("window").height;
  const slide = progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] });
  const onLayout = (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height);

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={required ? () => undefined : onClose}
    >
      <View style={[styles.modalRoot, !visible && styles.leaving]}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.scrim }]}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            accessible={!required}
            onPress={required ? undefined : onClose}
          />
        </Animated.View>
        <Animated.View
          {...pan.panHandlers}
          accessibilityViewIsModal
          onLayout={onLayout}
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surface,
              paddingBottom: insets.bottom + 16,
              opacity: rule.sheetFades ? progress : 1,
              transform: rule.sheetSlides
                ? [{ translateY: Animated.add(slide, drag) }]
                : [{ translateY: drag }],
            },
            floatStyle(theme.name),
          ]}
        >
          <View style={[styles.handle, { backgroundColor: theme.colors.borderField }]} />
          <Held hold={!visible}>
            {title && (
              <Text variant="title" accessibilityRole="header" style={styles.sheetTitle}>
                {title}
              </Text>
            )}
            {children}
          </Held>
        </Animated.View>
      </View>
    </Modal>
  );
}

export interface DialogProps {
  visible: boolean;
  onClose: () => void;
  /** Called once when the dialog has finished going away (see `SheetProps`). */
  onDismissed?: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons name the action ("Отменить заявку"), stacked (long Kazakh labels). */
  actions: ReactNode;
}

/**
 * Confirmation of irreversible actions: surface, radius 12, width up to 320.
 *
 * It fades in and out over 150 ms by the rule (`dialog`): the scrim is a
 * layer of its own and the dialog does not travel — so it is the same with
 * reduced motion, and never the platform's uncontrolled fade of the whole
 * window. Like a sheet it keeps showing what it showed while it goes.
 */
export function Dialog({ visible, onClose, onDismissed, title, children, actions }: DialogProps) {
  const { theme } = useTheme();
  const plan = useMotionPlan("dialog");
  const { progress, mounted } = useOverlayTransition(visible, plan, onDismissed);
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={[styles.dialogRoot, !visible && styles.leaving]}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.scrim, opacity: progress },
          ]}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.dialog,
            { backgroundColor: theme.colors.surface, opacity: progress },
            floatStyle(theme.name),
          ]}
        >
          <Held hold={!visible}>
            <Text variant="title" accessibilityRole="header">
              {title}
            </Text>
            {children && <Text color="textMuted">{children}</Text>}
            <View style={styles.dialogActions}>{actions}</View>
          </Held>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: "center" },
  banner: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: "flex-start",
  },
  bannerBody: { flex: 1, gap: 8 },
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: radius.s,
  },
  list: { borderRadius: radius.m, overflow: "hidden" },
  skeletonRow: { flexDirection: "row", gap: 12, padding: layout.rowPadding },
  skeletonLines: { flex: 1, gap: 8, paddingTop: 4 },
  empty: { alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 32 },
  emptyAction: { marginTop: 8, alignSelf: "stretch", alignItems: "center" },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  // A sheet or a dialog that is going away no longer takes taps: what it still
  // shows is what it showed when it was closed, and a tap on that could start
  // an action nobody asks for any more («Отмена», then «Удалить» in the fade).
  leaving: { pointerEvents: "none" },
  sheet: {
    borderTopLeftRadius: radius.l,
    borderTopRightRadius: radius.l,
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 12,
  },
  handle: {
    alignSelf: "center",
    width: size.sheetHandle.width,
    height: size.sheetHandle.height,
    borderRadius: 2,
    marginBottom: 8,
  },
  sheetTitle: { marginBottom: 4 },
  dialogRoot: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  dialog: {
    width: "100%",
    maxWidth: size.dialogMaxWidth,
    borderRadius: radius.l,
    padding: 20,
    paddingTop: 24,
    gap: 12,
  },
  dialogActions: { gap: 8, marginTop: 8 },
});
