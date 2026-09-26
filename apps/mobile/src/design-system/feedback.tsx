import {
  bannerTones,
  floatShadow,
  motion,
  radius,
  sheetMotion,
  size,
  type BannerTone,
  type IconName,
} from "@adclub/ui-core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type DimensionValue,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "./Button";
import { Icon } from "./Icon";
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

/** Confirmations only ("Код скопирован"), 4 s; errors stay in the screen (7.7). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    setMessage(text);
    AccessibilityInfo.announceForAccessibility(text);
    timer.current = setTimeout(() => setMessage(null), motion.toast);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {message !== null && (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[
            styles.toast,
            { bottom: insets.bottom + 96, backgroundColor: theme.colors.toast },
            floatStyle(theme.name),
          ]}
        >
          <Icon name="circleCheck" size={20} colorValue={theme.colors.onToast} />
          <Text variant="bodyS" style={[styles.flex, { color: theme.colors.onToast }]}>
            {message}
          </Text>
        </View>
      )}
    </ToastContext.Provider>
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
      style={[
        styles.list,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          style={[
            styles.skeletonRow,
            index > 0 && { borderTopWidth: 1, borderTopColor: theme.colors.border },
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
  children: ReactNode;
}

/**
 * Bottom sheet: surface, radius 12 on top, handle 36 × 4, padding 16, scrim
 * below (DESIGN 7.7).
 *
 * The motion is the component's own (`sheetMotion`, DESIGN 7.6) and not the
 * platform's: `Modal animationType="slide"` moves the **whole** window, so
 * the scrim travelled up from the bottom edge together with the sheet. Here
 * the scrim is what it is meant to be — a layer under the sheet that only
 * changes opacity — while the sheet slides up over 250 ms with deceleration
 * at the end. With "reduce motion" nothing moves: both only fade. Closing
 * plays the same animation backwards, and the modal stays mounted until it
 * has finished, so there is no jump.
 */
export function Sheet({ visible, onClose, title, closeLabel, required, children }: SheetProps) {
  const { theme, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const plan = sheetMotion(reduceMotion);
  // 0 — closed, 1 — open: the scrim's opacity and how far the sheet has travelled.
  const [progress] = useState(() => new Animated.Value(0));
  const [drag] = useState(() => new Animated.Value(0));
  /** The sheet's own height: that is all it has to travel. */
  const [height, setHeight] = useState(0);
  /**
   * Keeps the modal on screen for one more animation after `visible` has
   * gone false, so closing is not a jump. It is raised on the frame after
   * the sheet is asked for and lowered when the closing animation ends. The
   * modal's own `visible` is `visible || held`, so a sheet can never end up
   * refusing to open: opening never waits for this flag.
   */
  const [held, setHeld] = useState(false);

  useEffect(() => {
    drag.setValue(0);
    let animation: ReturnType<typeof Animated.timing> | null = null;
    /*
     * A frame later, not right now: the modal mounts its content after this
     * effect, and the views the value was attached to before are detached
     * then — and detaching an animated value stops whatever is driving it
     * (`AnimatedValue.__detach`). Started in the same tick, the opening
     * animation was killed a few frames in and the sheet stayed off screen.
     */
    const frame = requestAnimationFrame(() => {
      if (visible) setHeld(true);
      animation = Animated.timing(progress, {
        toValue: visible ? 1 : 0,
        duration: plan.durationMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });
      animation.start(({ finished }) => {
        // Unmount only after the closing animation has played to the end.
        if (finished && !visible) setHeld(false);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      animation?.stop();
    };
  }, [visible, progress, drag, plan.durationMs]);

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
          Animated.timing(drag, {
            toValue: 0,
            duration: motion.fast,
            useNativeDriver: true,
          }).start();
        },
      }),
    [drag, onClose, required],
  );

  // Until the sheet is measured the window height keeps it off screen, so
  // nothing flashes on the first frame.
  const travel = height > 0 ? height : Dimensions.get("window").height;
  const slide = progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] });
  const onLayout = (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height);

  return (
    <Modal
      visible={visible || held}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={required ? () => undefined : onClose}
    >
      <View style={styles.modalRoot}>
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
              opacity: plan.sheetFades ? progress : 1,
              transform: plan.sheetSlides
                ? [{ translateY: Animated.add(slide, drag) }]
                : [{ translateY: drag }],
            },
            floatStyle(theme.name),
          ]}
        >
          <View style={[styles.handle, { backgroundColor: theme.colors.borderField }]} />
          {title && (
            <Text variant="title" accessibilityRole="header" style={styles.sheetTitle}>
              {title}
            </Text>
          )}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

export interface DialogProps {
  visible: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons name the action ("Отменить заявку"), stacked (long Kazakh labels). */
  actions: ReactNode;
}

/** Confirmation of irreversible actions: surface, radius 12, width up to 320. */
export function Dialog({ visible, onClose, title, children, actions }: DialogProps) {
  const { theme } = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={[styles.dialogRoot, { backgroundColor: theme.colors.scrim }]}>
        <View
          accessibilityViewIsModal
          style={[styles.dialog, { backgroundColor: theme.colors.surface }, floatStyle(theme.name)]}
        >
          <Text variant="title" accessibilityRole="header">
            {title}
          </Text>
          {children && <Text color="textMuted">{children}</Text>}
          <View style={styles.dialogActions}>{actions}</View>
        </View>
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
  list: { borderWidth: 1, borderRadius: radius.m, overflow: "hidden" },
  skeletonRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  skeletonLines: { flex: 1, gap: 8, paddingTop: 4 },
  empty: { alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 32 },
  emptyAction: { marginTop: 8, alignSelf: "stretch", alignItems: "center" },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
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
