import {
  aiPilotStates,
  type ColorToken,
  type Compatibility,
  compatibilityMarks,
  type IconName,
  type OrderStatusGroup,
  orderStatusGroups,
  type ThemeMode,
  typography,
  type TypographyToken,
} from "@adclub/ui-core";
import {
  AiBadge,
  Banner,
  BottomTabs,
  Button,
  Checkbox,
  Chip,
  CodeBlock,
  CodeCells,
  colorVar,
  CompatibilityMark,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  icons,
  kebab,
  Keypad,
  Logo,
  type NavItem,
  Quantity,
  Radio,
  Rating,
  ScreenError,
  SearchField,
  Segments,
  Sidebar,
  Skeleton,
  SkeletonList,
  StatusBadge,
  Switch,
  TextField,
  ToastProvider,
  typographyClass,
  useTheme,
  useToast,
} from "@adclub/ui";
import { useState, type ReactNode } from "react";
import { showcaseTexts, type ShowcaseLang, type ShowcaseTexts } from "./texts";

export interface ShowcaseProps {
  /** Which client hosts the page: the cabinet shows the "Сканер" tab bar. */
  app: "supplier" | "admin";
}

type NavKey = "orders" | "offers" | "scan" | "price" | "more" | "moderation" | "catalog" | "admins";

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="sc-section" id={id} aria-labelledby={`${id}-title`}>
      <h2 className="ac-text-title sc-section__title" id={`${id}-title`}>
        {title}
      </h2>
      {note && <p className="ac-text-body-s ac-muted sc-section__note">{note}</p>}
      <div className="sc-section__body">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sc-row">
      <div className="ac-text-caption ac-muted">{label}</div>
      <div className="sc-row__items">{children}</div>
    </div>
  );
}

function Header({
  t,
  lang,
  setLang,
}: {
  t: ShowcaseTexts;
  lang: ShowcaseLang;
  setLang: (lang: ShowcaseLang) => void;
}) {
  const { mode, setMode, theme } = useTheme();
  return (
    <header className="sc-header">
      <div className="sc-header__title">
        <h1 className="ac-text-title-l">{t.title}</h1>
        <p className="ac-text-body-s ac-muted">
          {t.subtitle} · {theme.name === "dark" ? t.themeDark : t.themeLight}
        </p>
      </div>
      <div className="sc-header__controls">
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
      </div>
    </header>
  );
}

function BrandSection({ t }: { t: ShowcaseTexts }) {
  return (
    <Section id="brand" title={t.sections.brand} note={t.notes.brand}>
      <Row label={t.labels.logoAuto}>
        <Logo height={56} />
        <Logo mark height={32} />
      </Row>
      <Row label={t.labels.logoFixed}>
        <span className="sc-swatch-tile sc-swatch-tile--dark">
          <Logo variant="champagne" height={40} />
        </span>
        <span className="sc-swatch-tile sc-swatch-tile--light">
          <Logo variant="graphite" height={40} />
        </span>
        <span className="sc-swatch-tile sc-swatch-tile--photo">
          <Logo variant="white" height={40} />
        </span>
        <img src="/favicon.svg" width={48} height={48} alt="favicon.svg" />
      </Row>
    </Section>
  );
}

const colorGroups: ColorToken[][] = [
  ["bg", "bar", "surface", "surfaceRaised", "fill", "border", "borderField"],
  [
    "text",
    "textMuted",
    "textDisabled",
    "accent",
    "accentTint",
    "accentOnTint",
    "primary",
    "onPrimary",
  ],
  ["success", "successTint", "warning", "warningTint", "danger", "dangerTint", "onDanger"],
  ["ai", "aiTint", "aiBorder", "scrim", "qrFg", "qrBg", "toast", "onToast"],
];

function ColorsSection({ t }: { t: ShowcaseTexts }) {
  const { theme } = useTheme();
  return (
    <Section id="colors" title={t.sections.colors} note={t.notes.colors}>
      {colorGroups.map((group, index) => (
        <div className="sc-swatches" key={index}>
          {group.map((token) => (
            <div className="sc-swatch" key={token}>
              <span className="sc-swatch__color" style={{ background: colorVar(token) }} />
              <span className="ac-text-caption-strong">{token}</span>
              <span className="ac-text-caption ac-muted ac-num">{theme.colors[token]}</span>
            </div>
          ))}
        </div>
      ))}
    </Section>
  );
}

function TypographySection({ t }: { t: ShowcaseTexts }) {
  const numeric: TypographyToken[] = ["price", "priceS", "code", "codeXL"];
  return (
    <Section id="type" title={t.sections.typography} note={t.notes.typography}>
      {(Object.keys(typography) as TypographyToken[]).map((token) => {
        const style = typography[token];
        return (
          <div className="sc-type" key={token}>
            <span className="ac-text-caption ac-muted sc-type__meta">
              {token} · {style.fontSize}/{style.lineHeight} · {style.fontWeight}
            </span>
            <span className={typographyClass(token)}>
              {numeric.includes(token)
                ? token.startsWith("code")
                  ? "482 915"
                  : "12 500 ₸ · 1 118 ₸"
                : t.sample}
            </span>
          </div>
        );
      })}
    </Section>
  );
}

function IconsSection({ t }: { t: ShowcaseTexts }) {
  const names = Object.keys(icons) as IconName[];
  return (
    <Section id="icons" title={t.sections.icons} note={t.notes.icons}>
      {([16, 20, 24] as const).map((size) => (
        <Row label={`${size}px`} key={size}>
          {names.map((name) => (
            <span className="sc-icon" title={kebab(name)} key={name}>
              <Icon name={name} size={size} />
            </span>
          ))}
        </Row>
      ))}
      <Row label={t.labels.iconButton}>
        <IconButton icon="arrowLeft" label={t.back} />
        <IconButton icon="x" label={t.close} />
        <IconButton icon="search" label={t.search} />
      </Row>
    </Section>
  );
}

function ButtonsSection({ t }: { t: ShowcaseTexts }) {
  const [loading, setLoading] = useState(false);
  const [presses, setPresses] = useState(0);
  const slowAction = () => {
    setPresses((count) => count + 1);
    return new Promise((resolve) => setTimeout(resolve, 2000));
  };
  return (
    <Section id="buttons" title={t.sections.buttons} note={t.notes.buttons}>
      {(["l", "m", "s"] as const).map((size) => (
        <Row label={`${t.labels.size} ${size.toUpperCase()}`} key={size}>
          <Button size={size}>{t.primary}</Button>
          <Button size={size} variant="secondary">
            {t.secondary}
          </Button>
          <Button size={size} variant="text">
            {t.textButton}
          </Button>
          <Button size={size} variant="danger" icon="trash">
            {t.danger}
          </Button>
        </Row>
      ))}
      <Row label={t.labels.states}>
        <Button disabled>{t.disabled}</Button>
        <Button variant="secondary" disabled>
          {t.disabled}
        </Button>
        <Button loading>{t.primary}</Button>
        <Button variant="secondary" loading>
          {t.secondary}
        </Button>
        <Button variant="secondary" destructive>
          {t.cancelOrder}
        </Button>
      </Row>
      <Row label={t.labels.pressGuard}>
        <Button onClick={slowAction} icon="refresh">
          {t.slowAction}
        </Button>
        <Button variant="secondary" loading={loading} onClick={() => setLoading(true)}>
          {t.controlledLoading}
        </Button>
        {loading && (
          <Button variant="text" onClick={() => setLoading(false)}>
            {t.stop}
          </Button>
        )}
        <span className="ac-text-body-s ac-num" aria-live="polite">
          {t.pressCount}: {presses}
        </span>
      </Row>
      <Row label={t.labels.longLabel}>
        <div className="sc-narrow">
          <Button size="l" block>
            {t.longButton}
          </Button>
        </div>
      </Row>
    </Section>
  );
}

function FieldsSection({ t }: { t: ShowcaseTexts }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+7 701 12");
  const [vin, setVin] = useState("XWB3L32EDJA123456");
  const [aiConfirmed, setAiConfirmed] = useState(false);
  const [search, setSearch] = useState(t.searchValue);
  const [code, setCode] = useState("4829");
  const [badCode, setBadCode] = useState("482915");
  return (
    <Section id="fields" title={t.sections.fields} note={t.notes.fields}>
      <div className="sc-grid">
        <TextField
          label={t.fieldName}
          value={name}
          onChange={setName}
          hint={t.fieldHint}
          placeholder={t.placeholder}
        />
        <TextField
          label={t.fieldPhone}
          value={phone}
          onChange={setPhone}
          inputMode="tel"
          error={t.fieldError}
        />
        <TextField
          label={t.fieldDisabled}
          value={t.disabledValue}
          onChange={() => undefined}
          disabled
        />
        <TextField
          label="VIN"
          value={vin}
          onChange={(value) => {
            setVin(value);
            setAiConfirmed(true);
          }}
          aiLabel={aiConfirmed ? undefined : t.recognized}
          confirmed={aiConfirmed}
          hint={aiConfirmed ? t.aiConfirmedHint : t.aiHint}
          className="ac-num"
        />
      </div>
      {!aiConfirmed && (
        <Button variant="secondary" size="m" icon="check" onClick={() => setAiConfirmed(true)}>
          {t.confirm}
        </Button>
      )}
      <SearchField
        label={t.search}
        clearLabel={t.clear}
        value={search}
        onChange={setSearch}
        placeholder={t.searchPlaceholder}
      />
      <div className="sc-grid">
        <div>
          <CodeCells label={t.codeLabel} value={code} onChange={setCode} />
          <div className="sc-keypad">
            <Keypad
              eraseLabel={t.erase}
              onDigit={(digit) => setCode((value) => (value + digit).slice(0, 6))}
              onErase={() => setCode((value) => value.slice(0, -1))}
              submit={{ label: t.find, onPress: () => undefined, disabled: code.length < 6 }}
            />
          </div>
        </div>
        <CodeCells label={t.codeLabel} value={badCode} onChange={setBadCode} error={t.codeError} />
      </div>
    </Section>
  );
}

function ChoiceSection({ t }: { t: ShowcaseTexts }) {
  const [chips, setChips] = useState<string[]>([t.chips[0] ?? ""]);
  const [sort, setSort] = useState("recommended");
  const [push, setPush] = useState(true);
  const [agree, setAgree] = useState(false);
  const [delivery, setDelivery] = useState("pickup");
  const [quantity, setQuantity] = useState(1);
  return (
    <Section id="choice" title={t.sections.choice} note={t.notes.choice}>
      <Row label={t.labels.chips}>
        {t.chips.map((chip) => (
          <Chip
            key={chip}
            selected={chips.includes(chip)}
            onClick={() =>
              setChips((current) =>
                current.includes(chip) ? current.filter((c) => c !== chip) : [...current, chip],
              )
            }
          >
            {chip}
          </Chip>
        ))}
        <Chip disabled>{t.disabled}</Chip>
      </Row>
      <div className="sc-narrow">
        <Segments
          label={t.sort}
          value={sort}
          onChange={setSort}
          options={[
            { value: "recommended", label: t.segments[0] ?? "" },
            { value: "cheaper", label: t.segments[1] ?? "" },
            { value: "faster", label: t.segments[2] ?? "" },
          ]}
        />
      </div>
      <div className="sc-grid">
        <div>
          <Switch
            label={t.switchLabel}
            description={t.switchDescription}
            checked={push}
            onChange={setPush}
          />
          <Switch label={t.disabled} checked={false} onChange={() => undefined} disabled />
          <Checkbox label={t.checkboxLabel} checked={agree} onChange={setAgree} />
          <Checkbox label={t.disabled} checked onChange={() => undefined} disabled />
        </div>
        <div role="radiogroup" aria-label={t.delivery}>
          <Radio
            name="sc-delivery"
            label={t.pickup}
            checked={delivery === "pickup"}
            onChange={() => setDelivery("pickup")}
          />
          <Radio
            name="sc-delivery"
            label={t.courier}
            description={t.courierDescription}
            checked={delivery === "courier"}
            onChange={() => setDelivery("courier")}
          />
          <Radio
            name="sc-delivery"
            label={t.disabled}
            checked={false}
            onChange={() => undefined}
            disabled
          />
        </div>
      </div>
      <Row label={t.labels.quantity}>
        <Quantity
          value={quantity}
          onChange={setQuantity}
          max={5}
          label={t.quantity}
          decreaseLabel={t.decrease}
          increaseLabel={t.increase}
        />
      </Row>
    </Section>
  );
}

function MarksSection({ t, lang }: { t: ShowcaseTexts; lang: ShowcaseLang }) {
  return (
    <Section id="marks" title={t.sections.marks} note={t.notes.marks}>
      <Row label={t.labels.status}>
        {(Object.keys(orderStatusGroups) as OrderStatusGroup[]).map((group) => (
          <StatusBadge group={group} key={group}>
            {t.status[group]}
          </StatusBadge>
        ))}
      </Row>
      <Row label={t.labels.compatibility}>
        {(Object.keys(compatibilityMarks) as Compatibility[]).map((value) => (
          <CompatibilityMark value={value} key={value}>
            {t.compatibility[value]}
          </CompatibilityMark>
        ))}
      </Row>
      <Row label={t.labels.ai}>
        <AiBadge>{t.recognized}</AiBadge>
        <AiBadge>{t.proposed}</AiBadge>
      </Row>
      <Row label={t.labels.rating}>
        <Rating
          value={4.8}
          count={23}
          locale={lang === "kk" ? "kk-KZ" : "ru-RU"}
          label={t.ratingLabel}
          emptyText={t.noRating}
        />
        <Rating value={null} count={0} locale="ru-RU" label="" emptyText={t.noRating} />
      </Row>
      <Row label={t.labels.aiPilot}>
        <span className="ac-text-body-s ac-muted">
          {t.aiPilotWeb} ({aiPilotStates.join(", ")})
        </span>
      </Row>
    </Section>
  );
}

function FeedbackSection({ t }: { t: ShowcaseTexts }) {
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  return (
    <Section id="feedback" title={t.sections.feedback} note={t.notes.feedback}>
      <Banner icon="wifiOff">{t.offline}</Banner>
      <Banner
        tone="warning"
        action={
          <Button variant="text" size="m">
            {t.update}
          </Button>
        }
      >
        {t.paymentProblem}
      </Banner>
      <Banner tone="danger">{t.bannerError}</Banner>
      <Row label={t.labels.toastAndDialog}>
        <Button variant="secondary" icon="copy" onClick={() => toast.show(t.copied)}>
          {t.copyCode}
        </Button>
        <Button variant="secondary" destructive onClick={() => setDialog(true)}>
          {t.cancelOrder}
        </Button>
      </Row>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title={t.dialogTitle}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog(false)}>
              {t.keepOrder}
            </Button>
            <Button variant="danger" onClick={() => setDialog(false)}>
              {t.cancelOrder}
            </Button>
          </>
        }
      >
        {t.dialogText}
      </Dialog>
      <div className="sc-grid">
        <div>
          <div className="ac-text-caption ac-muted">{t.labels.skeleton}</div>
          <SkeletonList rows={2} label={t.loading} />
          <Skeleton width="60%" height={20} style={{ marginTop: 12 }} />
        </div>
        <div className="sc-card">
          <EmptyState
            icon="receipt"
            title={t.emptyTitle}
            text={t.emptyText}
            action={<Button variant="secondary">{t.resetFilters}</Button>}
          />
        </div>
        <div className="sc-card">
          <ScreenError
            title={t.errorTitle}
            text={t.errorText}
            retry={{ label: t.retry, onRetry: () => new Promise((r) => setTimeout(r, 1500)) }}
          />
        </div>
      </div>
    </Section>
  );
}

function TableSection({ t }: { t: ShowcaseTexts }) {
  return (
    <Section id="table" title={t.sections.table} note={t.notes.table}>
      <DataTable<"name" | "article" | "price" | "stock">
        caption={t.sections.table}
        columns={[
          { key: "name", header: t.table.name },
          { key: "article", header: t.table.article, autoDetectedLabel: t.table.auto },
          { key: "price", header: t.table.price, numeric: true },
          { key: "stock", header: t.table.stock, numeric: true },
        ]}
        rows={[
          {
            id: "1",
            cells: {
              name: t.sample,
              article: { value: "LR-0W30-4", ai: true },
              price: "12 500 ₸",
              stock: "14",
            },
          },
          {
            id: "2",
            cells: {
              name: t.table.pads,
              article: "GB-1014001",
              price: { value: "31 900 ₸", warning: true },
              stock: "3",
            },
          },
          {
            id: "3",
            cells: {
              name: t.table.filter,
              article: "1016051123",
              price: "4 200 ₸",
              stock: (
                <Button size="s" variant="secondary">
                  {t.table.edit}
                </Button>
              ),
            },
          },
        ]}
      />
    </Section>
  );
}

function CodeSection({ t }: { t: ShowcaseTexts }) {
  return (
    <Section id="code" title={t.sections.code} note={t.notes.code}>
      <div className="sc-grid">
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
      </div>
    </Section>
  );
}

function ShowcaseContent({ app }: ShowcaseProps) {
  const [lang, setLang] = useState<ShowcaseLang>("ru");
  const [active, setActive] = useState<NavKey>(app === "supplier" ? "orders" : "moderation");
  const t = showcaseTexts[lang];

  const supplierTabs: NavItem<NavKey>[] = [
    { key: "orders", label: t.nav.orders, icon: "receipt", count: 3, countLabel: t.nav.newOrders },
    { key: "offers", label: t.nav.offers, icon: "tags" },
    { key: "price", label: t.nav.price, icon: "fileSpreadsheet" },
    { key: "more", label: t.nav.more, icon: "dots" },
  ];
  const adminItems: NavItem<NavKey>[] = [
    { key: "moderation", label: t.nav.moderation, icon: "checklist", count: 12 },
    { key: "catalog", label: t.nav.catalog, icon: "category" },
    { key: "admins", label: t.nav.admins, icon: "user" },
    { key: "more", label: t.nav.more, icon: "dots" },
  ];
  const sidebarItems: NavItem<NavKey>[] =
    app === "supplier"
      ? [
          supplierTabs[0]!,
          { key: "scan", label: t.nav.scan, icon: "scan" },
          ...supplierTabs.slice(1, 3),
          { key: "more", label: t.nav.settings, icon: "settings" },
        ]
      : adminItems;

  return (
    <div className="sc-shell" lang={lang}>
      <div className="sc-shell__sidebar">
        <Sidebar
          label={t.nav.label}
          items={sidebarItems}
          active={active}
          onSelect={setActive}
          header={
            <div className="sc-sidebar-head">
              <Logo height={40} />
              <span className="ac-text-caption ac-muted">
                {app === "supplier" ? t.cabinet : t.admin}
              </span>
            </div>
          }
          footer={
            <span className="ac-text-body-s ac-muted sc-sidebar-user">
              <Icon name="user" size={20} /> Айжан
            </span>
          }
        />
      </div>
      <main className="sc-main">
        <div className="sc-content">
          <Header t={t} lang={lang} setLang={setLang} />
          <BrandSection t={t} />
          <ColorsSection t={t} />
          <TypographySection t={t} />
          <IconsSection t={t} />
          <ButtonsSection t={t} />
          <FieldsSection t={t} key={`fields-${lang}`} />
          <ChoiceSection t={t} key={`choice-${lang}`} />
          <MarksSection t={t} lang={lang} />
          <FeedbackSection t={t} />
          <TableSection t={t} />
          <CodeSection t={t} />
          <p className="ac-text-caption ac-muted">{t.footer}</p>
        </div>
      </main>
      <div className="sc-shell__tabs">
        {app === "supplier" ? (
          <BottomTabs
            label={t.nav.label}
            items={supplierTabs}
            active={active}
            onSelect={setActive}
            center={{ key: "scan", label: t.nav.scan, icon: "scan" }}
          />
        ) : (
          <BottomTabs label={t.nav.label} items={adminItems} active={active} onSelect={setActive} />
        )}
      </div>
    </div>
  );
}

/**
 * Development-only page with every web component in every state, both
 * themes, Russian and Kazakh labels (TASK-075). The web apps list this
 * package as a dev dependency and import it only when `import.meta.env.DEV`.
 */
export function Showcase({ app }: ShowcaseProps) {
  return (
    <ToastProvider>
      <style>{showcaseCss}</style>
      <ShowcaseContent app={app} />
    </ToastProvider>
  );
}

const showcaseCss = `
.sc-shell { display: flex; min-height: 100vh; }
.sc-shell__sidebar { display: none; position: sticky; top: 0; height: 100vh; }
.sc-shell__tabs { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; }
.sc-main { flex: 1; min-width: 0; padding: 16px 16px 120px; }
.sc-content { max-width: var(--ac-content-max-width); margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
.sc-header { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between; }
.sc-header h1, .sc-header p { margin: 0; }
.sc-header__controls { display: flex; flex-wrap: wrap; gap: 8px; }
.sc-header__controls .ac-segments { min-width: 280px; }
.sc-section { background: var(--ac-color-surface); border: 1px solid var(--ac-color-border); border-radius: var(--ac-radius-m); padding: 16px; }
.sc-section__title { margin: 0; }
.sc-section__note { margin: 4px 0 0; }
.sc-section__body { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }
.sc-row { display: flex; flex-direction: column; gap: 8px; }
.sc-row__items { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.sc-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
.sc-narrow { width: 100%; max-width: 360px; }
.sc-card { border: 1px solid var(--ac-color-border); border-radius: var(--ac-radius-m); background: var(--ac-color-bg); }
.sc-keypad { max-width: 320px; margin-top: 16px; }
.sc-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
.sc-swatch { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sc-swatch__color { height: 48px; border-radius: var(--ac-radius-s); border: 1px solid var(--ac-color-border); margin-bottom: 4px; }
.sc-swatch-tile { display: inline-flex; padding: 20px; border-radius: var(--ac-radius-m); }
.sc-swatch-tile--dark { background: #0F1012; }
.sc-swatch-tile--light { background: #F6F3EC; border: 1px solid var(--ac-color-border); }
.sc-swatch-tile--photo { background: #5b4a32; }
.sc-type { display: flex; flex-direction: column; gap: 2px; padding-bottom: 8px; border-bottom: 1px solid var(--ac-color-border); }
.sc-icon { display: inline-flex; color: var(--ac-color-text); }
.sc-sidebar-head { display: flex; flex-direction: column; gap: 8px; padding: 4px 12px 16px; }
.sc-sidebar-user { display: inline-flex; gap: 8px; align-items: center; padding: 0 12px; }
@media (min-width: 600px) {
  .sc-main { padding: 24px 24px 120px; }
  .sc-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: 1024px) {
  .sc-shell__sidebar { display: block; }
  .sc-shell__tabs { display: none; }
  .sc-main { padding: 24px 32px 48px; }
  .sc-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
`;
