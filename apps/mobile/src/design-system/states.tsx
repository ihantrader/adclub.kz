import { layout, motion, type IconName } from "@adclub/ui-core";
import { useEffect, useState, type ReactNode } from "react";
import { Animated, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Banner, EmptyState, ScreenError, type EmptyStateProps } from "./feedback";
import { TopBar } from "./navigation";
import { Text } from "./text";
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
  /** `false` for a screen that lays out its own list. */
  scroll?: boolean;
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
  scroll = true,
  children,
}: ScreenProps) {
  const { theme } = useTheme();
  const [scrolled, setScrolled] = useState(false);

  const content = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 4)}
      scrollEventThrottle={32}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={styles.flex}>{children}</View>
  );

  return (
    <SafeAreaView edges={["top"]} style={[styles.flex, { backgroundColor: theme.colors.bg }]}>
      {title !== undefined && (
        <TopBar title={title} root={root} back={back} actions={actions} scrolled={scrolled} />
      )}
      {banner}
      {refreshing && <RefreshLine label={refreshingLabel} />}
      {header}
      {content}
      {footer && <View style={styles.footer}>{footer}</View>}
    </SafeAreaView>
  );
}

/**
 * Refresh indicator over content that stays on screen (SCREENS 2.1): a thin
 * accent line, still without motion when "Уменьшить движение" is on.
 */
export function RefreshLine({ label }: { label?: string }) {
  const { theme, reduceMotion } = useTheme();
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.skeleton,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, reduceMotion]);

  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={[styles.refreshTrack, { backgroundColor: theme.colors.fill }]}
    >
      <Animated.View
        style={[
          styles.refreshBar,
          { backgroundColor: theme.colors.accent },
          !reduceMotion && {
            transform: [
              {
                translateX: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-120, 320],
                }),
              },
            ],
          },
        ]}
      />
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
 */
export function DataState({ status, skeleton, error, empty, offline, children }: DataStateProps) {
  switch (status) {
    case "loading":
      return <>{skeleton}</>;
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

/** A block of a screen: heading plus content, 24 between blocks (DESIGN 7.5). */
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
  footer: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 8,
  },
  refreshTrack: { height: 2, overflow: "hidden" },
  refreshBar: { width: 120, height: 2 },
  section: { gap: 12, paddingTop: layout.blockGap },
});
