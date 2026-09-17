import {
  aiPilotStates,
  compatibilityMarks,
  orderStatusGroups,
  typography,
  type AiPilotState,
  type ColorToken,
  type Compatibility,
  type IconName,
  type OrderStatusGroup,
  type ThemeMode,
  type TypographyToken,
} from "@adclub/ui-core";
import { useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  AiBadge,
  AiPilot,
  Banner,
  BottomTabs,
  Button,
  Checkbox,
  Chip,
  CodeBlock,
  CodeCells,
  CompatibilityMark,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  icons,
  Keypad,
  ListRow,
  Quantity,
  Radio,
  Rating,
  ScreenError,
  SearchField,
  Segments,
  Sheet,
  SkeletonList,
  StatusBadge,
  Switch,
  Text,
  TextField,
  TopBar,
  useTheme,
  useToast,
  type TabItem,
} from "../design-system";
import { showcaseTexts, type ShowcaseLang, type ShowcaseTexts } from "./showcase-texts";

type Tab = "catalog" | "orders" | "pilot" | "garage" | "profile";

const tabItems = (t: ShowcaseTexts): TabItem<Tab>[] => [
  { key: "catalog", label: t.tabs.catalog, icon: "category" },
  { key: "orders", label: t.tabs.orders, icon: "receipt" },
  { key: "garage", label: t.tabs.garage, icon: "car" },
  { key: "profile", label: t.tabs.profile, icon: "user" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.section,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Text variant="title" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <Text variant="caption" color="textMuted">
      {children}
    </Text>
  );
}

const colorTokens: ColorToken[] = [
  "bg",
  "bar",
  "surface",
  "surfaceRaised",
  "fill",
  "border",
  "borderField",
  "text",
  "textMuted",
  "textDisabled",
  "accent",
  "accentTint",
  "accentOnTint",
  "primary",
  "onPrimary",
  "success",
  "successTint",
  "warning",
  "warningTint",
  "danger",
  "dangerTint",
  "onDanger",
  "ai",
  "aiTint",
  "aiBorder",
  "qrFg",
  "qrBg",
  "toast",
  "onToast",
];

function PilotSection({ t }: { t: ShowcaseTexts }) {
  const { theme } = useTheme();
  const tiles: { colorway: "on-champagne" | "on-graphite"; background: string; label: string }[] = [
    { colorway: "on-champagne", background: "#D4B483", label: "on-champagne" },
    { colorway: "on-graphite", background: "#0F1012", label: "on-graphite" },
  ];
  return (
    <Section title="AI Pilot">
      <Caption>{t.pilotNote}</Caption>
      {tiles.map((tile) => (
        <View key={tile.colorway} style={styles.wrap}>
          {aiPilotStates.map((state: AiPilotState) => (
            <View key={state} style={styles.pilotCell}>
              <View style={[styles.pilotCircle, { backgroundColor: tile.background }]}>
                <AiPilot state={state} colorway={tile.colorway} size={48} />
              </View>
              <Caption>{t.pilotStates[state]}</Caption>
            </View>
          ))}
        </View>
      ))}
      <View style={styles.row}>
        <View style={[styles.avatar, { backgroundColor: theme.colors.fill }]}>
          <AiPilot state="happy" colorway="on-graphite" size={32} />
        </View>
        <Text variant="caption" color="accent">
          AI Pilot
        </Text>
      </View>
    </Section>
  );
}

function Content({
  t,
  lang,
  setLang,
}: {
  t: ShowcaseTexts;
  lang: ShowcaseLang;
  setLang: (lang: ShowcaseLang) => void;
}) {
  const { theme, mode, setMode, reduceMotion } = useTheme();
  const toast = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+7 701 12");
  const [vin, setVin] = useState("XWB3L32EDJA123456");
  const [vinConfirmed, setVinConfirmed] = useState(false);
  const [search, setSearch] = useState(t.searchValue);
  const [code, setCode] = useState("4829");
  const [chips, setChips] = useState<number[]>([0]);
  const [sort, setSort] = useState("recommended");
  const [push, setPush] = useState(true);
  const [agree, setAgree] = useState(false);
  const [delivery, setDelivery] = useState("pickup");
  const [quantity, setQuantity] = useState(1);
  const [sheet, setSheet] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [presses, setPresses] = useState(0);
  const [previewTab, setPreviewTab] = useState<Tab>("catalog");

  return (
    <>
      <Section title={t.theme}>
        <Segments<ThemeMode>
          label={t.theme}
          value={mode}
          onChange={setMode}
          options={[
            { value: "dark", label: t.themeDark, icon: "moon" },
            { value: "light", label: t.themeLight, icon: "sun" },
            { value: "system", label: t.themeSystem, icon: "settings" },
          ]}
        />
        <Segments<ShowcaseLang>
          label={t.language}
          value={lang}
          onChange={setLang}
          options={[
            { value: "ru", label: "Русский" },
            { value: "kk", label: "Қазақша" },
          ]}
        />
        <Caption>
          {t.current}: {theme.name} · {t.reduceMotion}: {reduceMotion ? t.on : t.off}
        </Caption>
      </Section>

      <PilotSection t={t} />

      <Section title={t.sections.colors}>
        <View style={styles.wrap}>
          {colorTokens.map((token) => (
            <View key={token} style={styles.swatch}>
              <View
                style={[
                  styles.swatchColor,
                  { backgroundColor: theme.colors[token], borderColor: theme.colors.border },
                ]}
              />
              <Text variant="captionStrong">{token}</Text>
              <Caption>{theme.colors[token]}</Caption>
            </View>
          ))}
        </View>
      </Section>

      <Section title={t.sections.typography}>
        {(Object.keys(typography) as TypographyToken[]).map((token) => (
          <View key={token}>
            <Caption>
              {token} · {typography[token].fontSize}/{typography[token].lineHeight}
            </Caption>
            <Text variant={token}>
              {token.startsWith("code")
                ? "482 915"
                : token.startsWith("price")
                  ? "12 500 ₸"
                  : t.sample}
            </Text>
          </View>
        ))}
      </Section>

      <Section title={t.sections.icons}>
        {([16, 20, 24] as const).map((iconSize) => (
          <View key={iconSize} style={styles.wrap}>
            {(Object.keys(icons) as IconName[]).map((iconName) => (
              <Icon key={iconName} name={iconName} size={iconSize} />
            ))}
          </View>
        ))}
        <View style={styles.row}>
          <IconButton icon="arrowLeft" label={t.back} onPress={() => undefined} />
          <IconButton icon="x" label={t.close} onPress={() => undefined} />
          <IconButton icon="search" label={t.search} onPress={() => undefined} />
        </View>
      </Section>

      <Section title={t.sections.buttons}>
        <Button>{t.primary}</Button>
        <Button variant="secondary">{t.secondary}</Button>
        <Button variant="secondary" size="m" destructive>
          {t.cancelOrder}
        </Button>
        <Button variant="text" size="m">
          {t.textButton}
        </Button>
        <Button variant="danger" icon="trash">
          {t.danger}
        </Button>
        <Button disabled>{t.disabled}</Button>
        <Button loading>{t.primary}</Button>
        <Caption>{t.pressGuard}</Caption>
        <Button
          variant="secondary"
          icon="refresh"
          onPress={() => {
            setPresses((count) => count + 1);
            return new Promise((resolve) => setTimeout(resolve, 2000));
          }}
        >
          {`${t.slowAction} · ${presses}`}
        </Button>
        <Button>{t.longButton}</Button>
      </Section>

      <Section title={t.sections.fields}>
        <TextField
          label={t.fieldName}
          value={name}
          onChangeText={setName}
          hint={t.fieldHint}
          placeholder={t.placeholder}
        />
        <TextField
          label={t.fieldPhone}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          error={t.fieldError}
        />
        <TextField
          label={t.fieldDisabled}
          value={t.disabledValue}
          onChangeText={() => undefined}
          disabled
        />
        <TextField
          label="VIN"
          value={vin}
          onChangeText={(value) => {
            setVin(value);
            setVinConfirmed(true);
          }}
          aiLabel={vinConfirmed ? undefined : t.recognized}
          confirmed={vinConfirmed}
          hint={vinConfirmed ? t.aiConfirmedHint : t.aiHint}
        />
        {!vinConfirmed && (
          <Button variant="secondary" size="m" icon="check" onPress={() => setVinConfirmed(true)}>
            {t.confirm}
          </Button>
        )}
        <SearchField
          label={t.search}
          clearLabel={t.clear}
          value={search}
          onChangeText={setSearch}
          placeholder={t.searchPlaceholder}
        />
        <CodeCells label={t.codeLabel} value={code} onChangeText={setCode} />
        <CodeCells
          label={t.codeLabel}
          value="482915"
          onChangeText={() => undefined}
          error={t.codeError}
        />
        <Keypad
          eraseLabel={t.erase}
          onDigit={(digit) => setCode((value) => (value + digit).slice(0, 6))}
          onErase={() => setCode((value) => value.slice(0, -1))}
          submit={{ label: t.find, onPress: () => undefined, disabled: code.length < 6 }}
        />
      </Section>

      <Section title={t.sections.choice}>
        <View style={styles.wrap}>
          {t.chips.map((chip, index) => (
            <Chip
              key={chip}
              selected={chips.includes(index)}
              onPress={() =>
                setChips((current) =>
                  current.includes(index)
                    ? current.filter((i) => i !== index)
                    : [...current, index],
                )
              }
            >
              {chip}
            </Chip>
          ))}
          <Chip disabled>{t.disabled}</Chip>
        </View>
        <Segments
          label={t.sort}
          value={sort}
          onChange={setSort}
          options={[
            { value: "recommended", label: t.segments[0] },
            { value: "cheaper", label: t.segments[1] },
            { value: "faster", label: t.segments[2] },
          ]}
        />
        <Switch
          label={t.switchLabel}
          description={t.switchDescription}
          checked={push}
          onChange={setPush}
        />
        <Switch label={t.disabled} checked={false} onChange={() => undefined} disabled />
        <Checkbox label={t.checkboxLabel} checked={agree} onChange={setAgree} />
        <Checkbox label={t.disabled} checked onChange={() => undefined} disabled />
        <Radio
          label={t.pickup}
          checked={delivery === "pickup"}
          onSelect={() => setDelivery("pickup")}
        />
        <Radio
          label={t.courier}
          description={t.courierDescription}
          checked={delivery === "courier"}
          onSelect={() => setDelivery("courier")}
        />
        <Quantity
          value={quantity}
          onChange={setQuantity}
          max={5}
          label={t.quantity}
          decreaseLabel={t.decrease}
          increaseLabel={t.increase}
        />
      </Section>

      <Section title={t.sections.marks}>
        {(Object.keys(orderStatusGroups) as OrderStatusGroup[]).map((group) => (
          <StatusBadge key={group} group={group}>
            {t.status[group]}
          </StatusBadge>
        ))}
        {(Object.keys(compatibilityMarks) as Compatibility[]).map((value) => (
          <CompatibilityMark key={value} value={value}>
            {t.compatibility[value]}
          </CompatibilityMark>
        ))}
        <AiBadge>{t.proposed}</AiBadge>
        <Rating
          value={4.8}
          count={23}
          locale={lang === "kk" ? "kk-KZ" : "ru-RU"}
          label={t.ratingLabel}
          emptyText={t.noRating}
        />
        <Rating value={null} count={0} locale="ru-RU" label="" emptyText={t.noRating} />
      </Section>

      <Section title={t.sections.feedback}>
        <Banner icon="wifiOff">{t.offline}</Banner>
        <Banner tone="warning">{t.paymentProblem}</Banner>
        <Banner tone="danger">{t.bannerError}</Banner>
        <Button variant="secondary" size="m" icon="copy" onPress={() => toast.show(t.copied)}>
          {t.copyCode}
        </Button>
        <Button variant="secondary" size="m" onPress={() => setSheet(true)}>
          {t.openSheet}
        </Button>
        <Button variant="secondary" size="m" destructive onPress={() => setDialog(true)}>
          {t.cancelOrder}
        </Button>
        <SkeletonList rows={2} label={t.loading} />
        <EmptyState
          icon="receipt"
          title={t.emptyTitle}
          text={t.emptyText}
          action={
            <Button variant="secondary" size="m">
              {t.resetFilters}
            </Button>
          }
        />
        <ScreenError
          title={t.errorTitle}
          text={t.errorText}
          retry={{
            label: t.retry,
            onRetry: () => new Promise((resolve) => setTimeout(resolve, 1500)),
          }}
        />
      </Section>

      <Section title={t.sections.list}>
        <View style={[styles.list, { borderColor: theme.colors.border }]}>
          <ListRow
            first
            icon="car"
            title="Geely Monjaro"
            subtitle="2.0 T · 2024"
            navigates
            onPress={() => undefined}
          />
          <ListRow
            icon="moon"
            title={t.theme}
            subtitle={t.themeDark}
            navigates
            onPress={() => undefined}
          />
          <ListRow
            title={t.sample}
            trailing={<StatusBadge group="ready">{t.status.ready}</StatusBadge>}
          />
        </View>
      </Section>

      <Section title={t.sections.code}>
        <CodeBlock
          code="482915"
          qrValue="adclub:order:482915"
          codeLabel={t.codeTitle}
          qrLabel={t.qrLabel}
        />
        <CodeBlock
          code="482915"
          qrValue="adclub:order:482915"
          codeLabel={t.codeTitle}
          qrLabel={t.qrLabel}
          ready
        />
        <CodeBlock
          code="482915"
          qrValue="adclub:order:482915"
          codeLabel={t.codeTitle}
          qrLabel={t.qrLabel}
          pending={{ text: t.codePending }}
        />
      </Section>

      <Section title={t.sections.tabs}>
        <Caption>{t.tabsFour}</Caption>
        <View style={[styles.tabsPreview, { borderColor: theme.colors.border }]}>
          <BottomTabs items={tabItems(t)} active={previewTab} onSelect={setPreviewTab} />
        </View>
      </Section>

      <Sheet
        visible={sheet}
        onClose={() => setSheet(false)}
        title={t.sheetTitle}
        closeLabel={t.close}
      >
        <Text color="textMuted">{t.sheetText}</Text>
        <Radio
          label={t.pickup}
          checked={delivery === "pickup"}
          onSelect={() => setDelivery("pickup")}
        />
        <Radio
          label={t.courier}
          checked={delivery === "courier"}
          onSelect={() => setDelivery("courier")}
        />
        <Button onPress={() => setSheet(false)}>{t.apply}</Button>
      </Sheet>
      <Dialog
        visible={dialog}
        onClose={() => setDialog(false)}
        title={t.dialogTitle}
        actions={
          <>
            <Button variant="danger" size="m" onPress={() => setDialog(false)}>
              {t.cancelOrder}
            </Button>
            <Button variant="secondary" size="m" onPress={() => setDialog(false)}>
              {t.keepOrder}
            </Button>
          </>
        }
      >
        {t.dialogText}
      </Dialog>
    </>
  );
}

/** Development-only screen with every mobile component (TASK-075). */
export default function ShowcaseScreen({ onClose }: { onClose: () => void }) {
  const { theme } = useTheme();
  const [lang, setLang] = useState<ShowcaseLang>("ru");
  const [scrolled, setScrolled] = useState(false);
  const [tab, setTab] = useState<Tab>("pilot");
  const t = showcaseTexts[lang];
  return (
    <SafeAreaView edges={[]} style={[styles.screen, { backgroundColor: theme.colors.bg }]}>
      <TopBar
        title={t.title}
        root
        scrolled={scrolled}
        actions={<IconButton icon="x" label={t.close} onPress={onClose} />}
      />
      <View style={styles.screen}>
        <ScrollView
          contentContainerStyle={styles.content}
          onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 4)}
          scrollEventThrottle={32}
        >
          <Content t={t} lang={lang} setLang={setLang} key={lang} />
        </ScrollView>
      </View>
      <BottomTabs
        items={tabItems(t)}
        active={tab}
        onSelect={setTab}
        aiPilot={{ key: "pilot", label: "AI Pilot", accessibilityLabel: t.pilotLabel }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 24, paddingBottom: 48 },
  section: { borderWidth: 1, borderRadius: 6, padding: 16, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 12, alignItems: "flex-start" },
  swatch: { width: 96, gap: 2 },
  swatchColor: { height: 40, borderRadius: 4, borderWidth: 1 },
  pilotCell: { alignItems: "center", gap: 4, width: 64 },
  pilotCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: { width: 32, height: 32, borderRadius: 16, overflow: "hidden" },
  list: { borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  tabsPreview: { borderWidth: 1, borderRadius: 6, overflow: "hidden" },
});
