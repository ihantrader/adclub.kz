import { layout, motion, type IconName } from "@adclub/ui-core";
import { useEffect, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Banner,
  EmptyState,
  ScreenError,
  useToastObstacle,
  type EmptyStateProps,
} from "./feedback";
import { TopBar } from "./navigation";
import { Text } from "./text";
import { useContentOpacity, useDelayedIndicator, useFadeTo } from "./loading";
import { useTheme } from "./theme";

/**
 * The cross-cutting states of SCREENS 2 in one place (TASK-027): every
 * screen of the app gets its loading skeleton, its refresh over existing
 * content, its error with "Повторить", its empty state and its "Нет сети"
 * from here instead of building them again. Texts are always props — the
 * dictionary lives in the app, not in the design system.
 */

export interface ScreenProps {
  title?: string;
  /** Root screens (Каталог, Заявки) use `titleL` (DESIGN 7.4). */
  root?: boolean;
  back?: { label: string; onPress: () => void };
  actions?: ReactNode;
  /** Flush under the top bar: "Нет сети" and other screen-wide notices. */
  banner?: ReactNode;
  /** Above the scroll area and never scrolled away (the city switch of the catalog). */
  header?: ReactNode;
  /** Pinned at the bottom: the main action of the screen. */
  footer?: ReactNode;
  /** A refresh on top of the content that is already shown (SCREENS 2.1). */
  refreshing?: boolean;
  /** Refresh label for screen readers. */
  refreshingLabel?: string;
  /**
   * What the content answers (another sort, another list): when it changes,
   * the new content fades in from the dimmed old one (DESIGN 7.6, D-069). A
   * reload of the same content changes nothing and does not fade.
   */
  contentKey?: unknown;
  /**
   * The old content cannot be touched while a reload is seen — for screens
   * where acting on what is about to go away would be wrong.
   */
  lockWhileRefreshing?: boolean;
  /**
   * Pulling the content down asks for a refresh (M-ORD-03, TASK-030). The
   * platform's spinner lets go at once; the refresh itself shows as the
   * line above, like any other refresh over content (SCREENS 2.1).
   */
  onPullToRefresh?: () => void;
  /** `false` for a screen that lays out its own list. */
  scroll?: boolean;
  /**
   * Centers the content vertically while it fits the screen, and still
   * scrolls when it does not (a bigger system font, a long Kazakh word) — a
   * single state that is the whole of the screen, such as «Добавьте
   * автомобиль» (TASK-028.B), rather than a list that starts at the top.
   */
  centerContent?: boolean;
  /**
   * Keeps the content clear of the bottom edge (the home indicator, the
   * system buttons). A screen inside the tabs does not need it — the tab bar
   * takes the inset — but the steps of choosing a car and the first run have
   * no tab bar under them, and their buttons must not sit in the gesture area.
   */
  bottomInset?: boolean;
  children: ReactNode;
}

/** Screen shell: safe area, background, top bar, banner, content, footer. */
export function Screen({
  title,
  root,
  back,
  actions,
  banner,
  header,
  footer,
  refreshing = false,
  refreshingLabel,
  contentKey,
  lockWhileRefreshing = false,
  onPullToRefresh,
  scroll = true,
  centerContent = false,
  bottomInset = false,
  children,
}: ScreenProps) {
  const { theme } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  // While a reload is seen the content stays where it is, dimmed under the
  // line; the next content takes its place with a fade (D-069).
  const opacity = useContentOpacity(refreshing, contentKey);

  const content = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.scrollContent, centerContent && styles.centeredContent]}
      keyboardShouldPersistTaps="handled"
      onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 4)}
      scrollEventThrottle={32}
      refreshControl={
        onPullToRefresh ? (
          <RefreshControl
            refreshing={false}
            onRefresh={onPullToRefresh}
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, centerContent && styles.centeredContent]}>{children}</View>
  );

  return (
    <SafeAreaView
      edges={bottomInset ? ["top", "bottom"] : ["top"]}
      style={[styles.flex, { backgroundColor: theme.colors.bg }]}
    >
      {title !== undefined && (
        <TopBar title={title} root={root} back={back} actions={actions} scrolled={scrolled} />
      )}
      {banner}
      {/* The slot is always there, so a refresh does not push the screen down 2 px and back. */}
      <RefreshLine label={refreshingLabel} active={refreshing} />
      {header}
      {/* The keyboard pushes the content and the footer up instead of covering
          the main button (iOS; Android resizes the window itself) — TASK-030.A. */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Animated.View
          style={[styles.flex, { opacity }]}
          pointerEvents={lockWhileRefreshing && refreshing ? "none" : "auto"}
          accessibilityState={{ busy: refreshing }}
        >
          {content}
        </Animated.View>
        {footer && <Footer>{footer}</Footer>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** The pinned main action of a screen: a toast stands above it, never on it (7.7, TASK-032). */
function Footer({ children }: { children: ReactNode }) {
  const { ref: footerRef, onLayout } = useToastObstacle();
  return (
    <View ref={footerRef} onLayout={onLayout} style={styles.footer}>
      {children}
    </View>
  );
}

/** The bar of the refresh line: 120 wide, sweeping from the left edge to the right one. */
const REFRESH_BAR = 120;

/**
 * Refresh indicator over content that stays on screen (SCREENS 2.1): a thin
 * accent line, still without motion when "Уменьшить движение" is on.
 *
 * Its 2 px are always in the layout — an empty track while nothing refreshes
 * — so a refresh that starts and ends does not push the whole screen down and
 * back up. The bar sweeps the width the track really has, not a number that
 * only suits one phone.
 */
export function RefreshLine({ label, active = true }: { label?: string; active?: boolean }) {
  const { theme, reduceMotion } = useTheme();
  const [progress] = useState(() => new Animated.Value(0));
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (reduceMotion || !active) return;
    // The track outlives the refresh, so its value must start from the left
    // edge each time: a native loop begins from where the value was left, and
    // a second refresh would sweep only what remained of the first.
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.skeleton,
        // A sweep that repeats runs at one speed: slowing it at the end of
        // each pass would show as the bar stopping at the edge.
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, reduceMotion, active]);

  return (
    <View
      // Only a line that is refreshing says anything to a screen reader.
      {...(active
        ? { accessible: true, accessibilityLabel: label, accessibilityState: { busy: true } }
        : {})}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.refreshTrack, { backgroundColor: active ? theme.colors.fill : "transparent" }]}
    >
      {active && (
        <Animated.View
          style={[
            styles.refreshBar,
            { backgroundColor: theme.colors.accent },
            !reduceMotion && {
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-REFRESH_BAR, width],
                  }),
                },
              ],
            },
          ]}
        />
      )}
    </View>
  );
}

export interface OfflineBannerProps {
  label: string;
  /** In the flow of a screen (radius 6) or flush under the top bar. */
  placement?: "inline" | "flush";
}

/** "Нет сети" (SCREENS 2.4): `fill` and the "no network" icon (DESIGN 7.7). */
export function OfflineBanner({ label, placement = "flush" }: OfflineBannerProps) {
  return (
    <Banner icon="wifiOff" placement={placement}>
      {label}
    </Banner>
  );
}

export interface OfflineContentProps {
  title: string;
  text?: string;
  /** "Мои активные заявки" — only when the device holds a saved copy (TASK-030). */
  action?: ReactNode;
}

/** The "Нет сети" state of a screen whose content needs the server (SCREENS 2.4). */
export function OfflineContent({ title, text, action }: OfflineContentProps) {
  return <EmptyState icon="wifiOff" title={title} text={text} action={action} />;
}

export type LoadStatus = "loading" | "error" | "empty" | "ready" | "offline";

export interface DataStateProps {
  status: LoadStatus;
  /** The skeleton of the real layout, not a spinner (SCREENS 2.1). */
  skeleton: ReactNode;
  error: { title: ReactNode; text?: ReactNode; retry?: { label: string; onRetry: () => unknown } };
  /** One of the four cases of SCREENS 2.2, with its own text and one action. */
  empty: EmptyStateProps;
  offline?: OfflineContentProps;
  children: ReactNode;
}

/**
 * One rule for "what is on the screen right now": the skeleton while
 * loading, the error with "Повторить", the empty state, the "Нет сети"
 * state, or the content.
 *
 * Loading by the rule (DESIGN 7.6, D-069): the skeleton keeps its place
 * from the start but is seen only after the delay — a quick answer comes
 * with no skeleton at all — and once seen it stays its minimum, so it never
 * blinks. What comes after it fades in.
 */
export function DataState(props: DataStateProps) {
  const loading = props.status === "loading";
  const indicator = useDelayedIndicator(loading);
  const skeletonOpacity = useFadeTo(indicator ? 1 : 0, 0);
  // Whether this place has waited: what comes after a wait fades in.
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) setWaited(true);

  if (loading || indicator) {
    return (
      <Animated.View
        style={{ opacity: skeletonOpacity }}
        importantForAccessibility={indicator ? "auto" : "no-hide-descendants"}
        accessibilityElementsHidden={!indicator}
      >
        {props.skeleton}
      </Animated.View>
    );
  }
  return waited ? (
    <FadeIn>
      <DataStateContent {...props} />
    </FadeIn>
  ) : (
    <DataStateContent {...props} />
  );
}

/** Appears from nothing by the swap rule (nothing fades under «Уменьшить движение»). */
function FadeIn({ children }: { children: ReactNode }) {
  const opacity = useFadeTo(1, 0);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

function DataStateContent({ status, error, empty, offline, children }: DataStateProps) {
  switch (status) {
    case "loading":
      return null;
    case "error":
      return <ScreenError title={error.title} text={error.text} retry={error.retry} />;
    case "offline":
      return offline ? (
        <OfflineContent {...offline} />
      ) : (
        <ScreenError title={error.title} text={error.text} retry={error.retry} />
      );
    case "empty":
      return <EmptyState {...empty} />;
    default:
      return <>{children}</>;
  }
}

export interface SectionProps {
  title?: string;
  icon?: IconName;
  children: ReactNode;
}

/** A block of a screen: heading plus content, 32 between blocks (DESIGN 7.5, D-068). */
export function Section({ title, children }: SectionProps) {
  return (
    <View style={styles.section}>
      {title !== undefined && (
        <Text variant="heading" accessibilityRole="header">
          {title}
        </Text>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrollContent: { paddingBottom: layout.blockGap },
  centeredContent: { flexGrow: 1, justifyContent: "center" },
  footer: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 8,
  },
  refreshTrack: { height: 2, overflow: "hidden" },
  refreshBar: { width: REFRESH_BAR, height: 2 },
  section: { gap: 12, paddingTop: layout.blockGap },
});
