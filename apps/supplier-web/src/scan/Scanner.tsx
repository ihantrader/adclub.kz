import type { SupplierScanOrder } from "@adclub/contracts";
import {
  Banner,
  Button,
  CodeCells,
  FadeSwap,
  Icon,
  Keypad,
  Spinner,
  useDelayedIndicator,
} from "@adclub/ui";
import { darkColors, scannerFrameColor } from "@adclub/ui-core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { apiClient } from "../api";
import { switchCompany } from "../cabinet/cabinet-store";
import { isOnline } from "../connection";
import { useLanguage, useT } from "../i18n";
import { Money, useAt } from "../orders/OrderParts";
import { formatDate, statusKey } from "../orders/order-rules";
import { goBack, navigate, useRouteState } from "../router";
import {
  browserCameraProblem,
  cameraProblemOf,
  createDecoder,
  deviceHasCamera,
  openCamera,
  setTorch,
  stopCamera,
  torchSupported,
  type CameraProblem,
  type QrDecoder,
} from "./camera";
import { blockLookupsUntil, handOver, lookupsBlockedUntil, takeHandedOver } from "./scan-handoff";
import {
  answerOfClose,
  answerOfError,
  answerOfLookup,
  createCodeEntryGate,
  createScanGate,
  resultIcon,
  resultTone,
  resultWords,
  shownCode,
  type Credential,
  type ScanResult,
} from "./scan-rules";

/**
 * Over the camera the colours are the dark theme's whatever the cabinet's
 * theme (DESIGN 7.10): the frame — dark `accent`, outside it — the dark
 * scrim (60 %), the text and the round buttons — dark `text` and `fill`.
 */
const cameraColors = {
  "--scanner-frame": scannerFrameColor,
  "--scanner-scrim": darkColors.scrim,
  "--scanner-text": darkColors.text,
  "--scanner-round": darkColors.fill,
  "--scanner-bg": darkColors.bg,
  "--scanner-on-frame": darkColors.onPrimary,
} as CSSProperties;

/** How often a frame of the camera is decoded. */
const DECODE_EVERY_MS = 200;
/** How long «Это не QR заявки клуба» stays over the camera. */
const FOREIGN_NOTICE_MS = 3_000;

type From = "camera" | "manual";

type View =
  | { kind: "camera" }
  | { kind: "manual" }
  | { kind: "searching"; from: From }
  | {
      kind: "found";
      from: From;
      order: SupplierScanOrder;
      late: { expiredAt: string; until: string } | null;
      /** From the card of the order (the lookup's answer has no customer data); `null` — unknown. */
      customerName: string | null;
    }
  | { kind: "result"; from: From; result: ScanResult };

type Camera =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "on"; torch: boolean }
  | { kind: "problem"; problem: CameraProblem };

/**
 * «Сканер» (S-SCAN-01…04, TASK-033): the camera on the whole screen at
 * once, QR codes decoded on the device, one request per QR in front of
 * the camera; the manual entry with its own keypad; the order found and
 * an explicit «Выдать»; the outcome on the colour of its kind. The code or
 * the QR content is held only for the request it is for (and for the
 * «Выдать» that follows it): in the memory of this page, never in the
 * address, the history, the storage of the browser or a log.
 */
export function Scanner({ companyName, timeZone }: { companyName: string; timeZone: string }) {
  const t = useT();
  const when = useAt(timeZone);
  const opened = useRouteState() as { manual?: boolean } | null;
  const [view, setView] = useState<View>(() =>
    opened?.manual ? { kind: "manual" } : { kind: "camera" },
  );
  const [camera, setCamera] = useState<Camera>({ kind: "idle" });
  /** The device has no camera at all: the manual entry is the scanner. */
  const [noCamera, setNoCamera] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [torchOn, setTorchOn] = useState(false);
  const [foreign, setForeign] = useState(false);
  const [code, setCode] = useState("");
  /** The cells as they are now, for the search that waited out a 429. */
  const codeRef = useRef("");
  /** What the customer showed, for the «Выдать» after the lookup (memory only). */
  const credential = useRef<Credential | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const decoder = useRef<QrDecoder | null>(null);
  const [gate] = useState(createScanGate);
  /** The sixth digit searches by itself, once per code typed (TASK-033.A). */
  const [entry] = useState(createCodeEntryGate);
  /**
   * After 429 the scanner sends no search until `Retry-After` (`until`);
   * `now` — when the minutes left were last counted. Typing goes on.
   */
  const [wait, setWait] = useState<{ until: number; now: number } | null>(() => {
    const until = lookupsBlockedUntil();
    const now = Date.now();
    return until > now ? { until, now } : null;
  });

  const close = () => goBack("orders");

  const finish = useCallback((from: From, result: ScanResult) => {
    // The credential outlives the request only for «Переключиться».
    if (result.kind !== "otherSupplier" || !result.supplier) credential.current = null;
    setView({ kind: "result", from, result });
  }, []);

  /** S-SCAN-02/03: what the code or the QR is. */
  const lookup = useCallback(
    async (shown: Credential, from: From) => {
      const now = Date.now();
      if (lookupsBlockedUntil() > now) {
        finish(from, {
          kind: "rateLimited",
          minutes: Math.max(1, Math.ceil((lookupsBlockedUntil() - now) / 60_000)),
          until: lookupsBlockedUntil(),
        });
        return;
      }
      if (!isOnline()) {
        finish(from, { kind: "offline", code: "code" in shown ? shown.code : null });
        return;
      }
      credential.current = shown;
      setView({ kind: "searching", from });
      let answer;
      try {
        answer = answerOfLookup(await apiClient.lookupSupplierOrder(shown));
      } catch (error) {
        answer = answerOfError(error, shown, Date.now());
      }
      if (answer.kind === "foreignQr") {
        credential.current = null;
        gate.reject("qr" in shown ? shown.qr : "", Date.now());
        setForeign(true);
        setView({ kind: "camera" });
        return;
      }
      if (answer.kind === "found") {
        setView({
          kind: "found",
          from,
          order: answer.order,
          late: answer.late,
          customerName: await customerNameOf(answer.order.id),
        });
        return;
      }
      if (answer.kind === "rateLimited") {
        blockLookupsUntil(answer.until);
        setWait({ until: answer.until, now: Date.now() });
      }
      finish(from, answer);
    },
    [finish, gate],
  );

  /**
   * The cells changed — by the keypad, a keyboard or a paste: the sixth
   * digit searches by itself (S-SCAN-02), once per code; while a 429 holds
   * the scanner, the code waits for `Retry-After`.
   */
  const typeCode = (next: string) => {
    setCode(next);
    codeRef.current = next;
    const held = lookupsBlockedUntil() > Date.now();
    if (entry.typed(next, held)) void lookup({ code: next }, "manual");
  };

  // The keypad goes from the cells as they are now, not as the last render
  // saw them: two taps faster than a render would otherwise both start from
  // the same digits.
  const typeDigit = (digit: string) => typeCode((codeRef.current + digit).slice(0, 6));
  const eraseDigit = () => typeCode(codeRef.current.slice(0, -1));

  /** A fresh, empty entry: the next six digits are a new code. */
  const clearCode = () => {
    setCode("");
    codeRef.current = "";
    entry.reset();
  };

  // The minutes of a 429 count down; when they are over, the code that
  // waited in the cells is searched — once, as if just typed.
  const manualOpen = view.kind === "manual";
  useEffect(() => {
    if (!wait) return;
    const timer = setTimeout(
      () => {
        const now = Date.now();
        if (now < wait.until) {
          setWait({ until: wait.until, now });
          return;
        }
        setWait(null);
        const typed = codeRef.current;
        if (manualOpen && entry.typed(typed, false)) void lookup({ code: typed }, "manual");
      },
      Math.min(Math.max(wait.until - Date.now(), 0), 15_000),
    );
    return () => clearTimeout(timer);
  }, [wait, manualOpen, entry, lookup]);

  /** «Выдать» / «Закрыть заявку»: the second, explicit press. */
  const giveOut = async (from: From) => {
    const shown = credential.current;
    if (!shown) return;
    if (!isOnline()) {
      finish(from, { kind: "offline", code: "code" in shown ? shown.code : null });
      return;
    }
    let answer;
    try {
      answer = answerOfClose(await apiClient.closeSupplierOrder(shown));
    } catch (error) {
      answer = answerOfError(error, shown, Date.now());
    }
    if (answer.kind === "found" || answer.kind === "foreignQr")
      answer = { kind: "failed" as const };
    if (answer.kind === "rateLimited") blockLookupsUntil(answer.until);
    finish(from, answer);
  };

  // The same code again, at the other company the employee switched to.
  // Taken in the timer, not the effect: an effect run twice (development)
  // cancels the first timer before the credential is taken.
  useEffect(() => {
    const timer = setTimeout(() => {
      const handed = takeHandedOver();
      if (handed) void lookup(handed, "code" in handed ? "manual" : "camera");
    });
    return () => clearTimeout(timer);
  }, [lookup]);

  // ------------------------------------------------------------ camera

  // The camera stays on while the scanning goes by camera — the order
  // found, «Выдать» and the outcome are on top of it — so «Сканировать
  // следующую» needs no new permission or start; the manual entry gives it back.
  const cameraWanted = view.kind === "camera" || (view.kind !== "manual" && view.from === "camera");

  useEffect(() => {
    if (!cameraWanted) return;
    let cancelled = false;
    const start = async () => {
      const unavailable = browserCameraProblem();
      if (unavailable) {
        setCamera({ kind: "problem", problem: unavailable });
        return;
      }
      if (!(await deviceHasCamera())) {
        if (cancelled) return;
        // A computer without a camera: the manual entry at once.
        setNoCamera(true);
        setCamera({ kind: "problem", problem: "noCamera" });
        setView({ kind: "manual" });
        return;
      }
      setCamera({ kind: "starting" });
      try {
        const stream = await openCamera();
        if (cancelled) {
          stopCamera(stream);
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        decoder.current ??= await createDecoder();
        if (!cancelled) setCamera({ kind: "on", torch: torchSupported(stream) });
      } catch (error) {
        if (!cancelled) setCamera({ kind: "problem", problem: cameraProblemOf(error) });
      }
    };
    void start();
    const onVisibility = () => {
      // A hidden page gives the camera back; on return it is taken again.
      if (document.visibilityState === "hidden") {
        stopCamera(streamRef.current);
        streamRef.current = null;
        setTorchOn(false);
        setCamera({ kind: "idle" });
      } else {
        setAttempt((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stopCamera(streamRef.current);
      streamRef.current = null;
      setTorchOn(false);
    };
  }, [cameraWanted, attempt]);

  const onDecoded = useRef<(text: string) => void>(() => undefined);
  useEffect(() => {
    onDecoded.current = (text: string) => {
      const verdict = gate.seen(text, Date.now());
      if (verdict === "foreign") setForeign(true);
      if (verdict === "act") void lookup({ qr: text }, "camera");
    };
  }, [gate, lookup]);

  useEffect(() => {
    if (camera.kind !== "on" || view.kind !== "camera") return;
    let stopped = false;
    let decoding = false;
    const timer = setInterval(async () => {
      const video = videoRef.current;
      if (decoding || !decoder.current || !video || video.readyState < 2) return;
      decoding = true;
      try {
        const text = await decoder.current.decode(video);
        if (!stopped && text) onDecoded.current(text);
      } catch {
        // A frame that could not be read: the next one will.
      } finally {
        decoding = false;
      }
    }, DECODE_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [camera.kind, view.kind]);

  useEffect(() => {
    if (!foreign) return;
    const timer = setTimeout(() => setForeign(false), FOREIGN_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [foreign]);

  /** «Сканировать следующую»: back to the camera, the gate open again. */
  const next = () => {
    credential.current = null;
    clearCode();
    gate.resume();
    setView(noCamera ? { kind: "manual" } : { kind: "camera" });
  };

  const toManual = () => {
    clearCode();
    setView({ kind: "manual" });
  };

  const waitMinutes =
    wait && wait.until > wait.now ? Math.max(1, Math.ceil((wait.until - wait.now) / 60_000)) : null;

  // --------------------------------------------------------------- views

  let content: ReactNode;
  switch (view.kind) {
    case "camera":
      content =
        camera.kind === "problem" ? (
          <CameraProblemPanel
            problem={camera.problem}
            companyName={companyName}
            onClose={close}
            onManual={toManual}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <div className="scanner__camera">
            <div className="scanner__frame" aria-hidden="true">
              <span className="scanner__corner scanner__corner--tl" />
              <span className="scanner__corner scanner__corner--tr" />
              <span className="scanner__corner scanner__corner--bl" />
              <span className="scanner__corner scanner__corner--br" />
            </div>
            <div className="scanner__top">
              <RoundButton icon="x" label={t("scan.close")} onClick={close} />
              <span className="scanner__company">{companyName}</span>
              {camera.kind === "on" && camera.torch ? (
                <RoundButton
                  icon="flashlight"
                  label={t(torchOn ? "scan.torchOff" : "scan.torchOn")}
                  pressed={torchOn}
                  onClick={() => {
                    const stream = streamRef.current;
                    if (!stream) return;
                    const on = !torchOn;
                    setTorch(stream, on).then(
                      () => setTorchOn(on),
                      () => undefined,
                    );
                  }}
                />
              ) : (
                <span className="scanner__round-space" />
              )}
            </div>
            <div className="scanner__bottom">
              <p className="scanner__hint" role="status">
                {foreign ? (
                  <span className="scanner__foreign">{t("scan.foreignQr")}</span>
                ) : camera.kind === "on" ? (
                  t("scan.aim")
                ) : (
                  <CameraStarting />
                )}
              </p>
              <button type="button" className="scanner__manual" onClick={toManual}>
                <Icon name="keyboard" size={20} />
                <span>{t("scan.manual")}</span>
              </button>
            </div>
          </div>
        );
      break;
    case "manual":
      content = (
        <ManualEntry
          companyName={companyName}
          code={code}
          onCode={typeCode}
          onDigit={typeDigit}
          onErase={eraseDigit}
          onClose={close}
          onCamera={noCamera ? null : next}
          searching={false}
          waitMinutes={waitMinutes}
        />
      );
      break;
    case "searching":
      // A typed code is searched under its own cells, held still meanwhile
      // (D-069: the indicator only after 300 ms) — the screen doesn't blink.
      content =
        view.from === "manual" ? (
          <ManualEntry
            companyName={companyName}
            code={code}
            onCode={typeCode}
            onDigit={typeDigit}
            onErase={eraseDigit}
            onClose={close}
            onCamera={null}
            searching
            waitMinutes={null}
          />
        ) : (
          <Searching companyName={companyName} onClose={close} />
        );
      break;
    case "found":
      content = (
        <Found
          companyName={companyName}
          order={view.order}
          late={view.late}
          customerName={view.customerName}
          when={when}
          onClose={close}
          onGiveOut={() => giveOut(view.from)}
          onCancel={next}
        />
      );
      break;
    case "result":
      content = (
        <ResultPanel
          result={view.result}
          from={view.from}
          when={when}
          companyName={companyName}
          onClose={close}
          onNext={next}
          onManual={toManual}
          onRetry={() => {
            const again = view.result.kind === "offline" && view.result.code;
            if (again) void lookup({ code: again }, "manual");
            else next();
          }}
          onSwitch={async (supplierId) => {
            const shown = credential.current;
            if (shown) handOver(shown);
            credential.current = null;
            await switchCompany(supplierId);
          }}
        />
      );
      break;
  }

  return (
    <div className="scanner" role="region" aria-label={t("tabs.scan")} style={cameraColors}>
      <video
        ref={videoRef}
        className={
          view.kind === "camera" && camera.kind !== "problem"
            ? "scanner__video"
            : "scanner__video scanner__video--hidden"
        }
        playsInline
        muted
        autoPlay
      />
      <FadeSwap
        className="scanner__view"
        fadeKey={
          view.kind === "camera"
            ? `camera-${camera.kind === "problem"}`
            : // A typed code is searched on the same screen: nothing to fade between.
              view.kind === "searching" && view.from === "manual"
              ? "manual"
              : view.kind
        }
      >
        {content}
      </FadeSwap>
    </div>
  );
}

/**
 * The customer's name for S-SCAN-03 («имя клиента, если заявка принята»):
 * the lookup's answer carries no customer data, the card of the order
 * found does (an order that can be given out was accepted). `""` — the
 * profile has no name; `null` — the card could not be read (the row is
 * left out, the order can still be given out).
 */
async function customerNameOf(orderId: string): Promise<string | null> {
  try {
    const { order } = await apiClient.getSupplierOrder({ orderId });
    return order.customer.kind === "revealed" ? (order.customer.name ?? "") : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ parts

function RoundButton({
  icon,
  label,
  onClick,
  pressed,
}: {
  icon: "x" | "flashlight" | "arrowLeft";
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={pressed ? "scanner__round scanner__round--on" : "scanner__round"}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon name={icon} size={24} />
    </button>
  );
}

function CameraStarting() {
  const t = useT();
  const indicator = useDelayedIndicator(true);
  return indicator ? <span>{t("scan.cameraStarting")}</span> : null;
}

/** The frame of every panel of the scanner that is not the camera: the company, back, close. */
function Panel({
  companyName,
  onClose,
  onBack,
  backLabel,
  tone,
  children,
}: {
  companyName: string;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  tone?: "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className={tone ? `scanner__panel scanner__panel--${tone}` : "scanner__panel"}>
      <div className="scanner__panel-top">
        {onBack ? (
          <button
            type="button"
            className="scanner__icon-button"
            aria-label={backLabel}
            title={backLabel}
            onClick={onBack}
          >
            <Icon name="arrowLeft" size={24} />
          </button>
        ) : (
          <span className="scanner__round-space" />
        )}
        <span className="scanner__company scanner__company--panel">{companyName}</span>
        <button
          type="button"
          className="scanner__icon-button"
          aria-label={t("scan.close")}
          title={t("scan.close")}
          onClick={onClose}
        >
          <Icon name="x" size={24} />
        </button>
      </div>
      <div className="scanner__panel-body">{children}</div>
    </div>
  );
}

function ManualEntry({
  companyName,
  code,
  onCode,
  onClose,
  onDigit,
  onErase,
  onCamera,
  searching,
  waitMinutes,
}: {
  companyName: string;
  code: string;
  /** Every change of the cells; the sixth digit searches by itself (TASK-033.A). */
  onCode: (code: string) => void;
  /** A key of the keypad: from the cells as they are now. */
  onDigit: (digit: string) => void;
  onErase: () => void;
  onClose: () => void;
  onCamera: (() => void) | null;
  /** The typed code is being searched: the cells and the keys wait. */
  searching: boolean;
  /** After 429: minutes until a search may go; the typing goes on meanwhile. */
  waitMinutes: number | null;
}) {
  const t = useT();
  const indicator = useDelayedIndicator(searching);
  // A touch screen gets the keypad of the page; a mouse and keyboard type straight in.
  const [finePointer] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches === true,
  );
  return (
    <Panel
      companyName={companyName}
      onClose={onClose}
      onBack={onCamera ?? undefined}
      backLabel={t("scan.toCamera")}
    >
      <div className="manual">
        <h1 className="ac-text-title">{t("scan.manualTitle")}</h1>
        <CodeCells
          label={t("scan.codeLabel")}
          value={code}
          onChange={onCode}
          autoFocus={finePointer}
          disabled={searching}
          systemKeyboard={false}
        />
        <p className="manual__status ac-text-body-s ac-muted" role="status" aria-live="polite">
          {indicator ? (
            <>
              <Spinner />
              <span>{t("scan.searching")}</span>
            </>
          ) : waitMinutes !== null && !searching ? (
            t("scan.searchWaits", { n: waitMinutes })
          ) : null}
        </p>
        <Keypad
          onDigit={onDigit}
          onErase={onErase}
          eraseLabel={t("scan.erase")}
          disabled={searching}
        />
      </div>
    </Panel>
  );
}

function Searching({ companyName, onClose }: { companyName: string; onClose: () => void }) {
  const t = useT();
  const indicator = useDelayedIndicator(true);
  return (
    <Panel companyName={companyName} onClose={onClose}>
      <div className="scanner__searching" role="status" aria-live="polite">
        {indicator && (
          <>
            <Spinner />
            <span>{t("scan.searching")}</span>
          </>
        )}
      </div>
    </Panel>
  );
}

function Found({
  companyName,
  order,
  late,
  customerName,
  when,
  onClose,
  onGiveOut,
  onCancel,
}: {
  companyName: string;
  order: SupplierScanOrder;
  late: { expiredAt: string; until: string } | null;
  customerName: string | null;
  when: (iso: string) => string;
  onClose: () => void;
  onGiveOut: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  return (
    <Panel companyName={companyName} onClose={onClose}>
      <div className="found">
        <h1 className="ac-text-title-l">{t("scan.foundTitle")}</h1>
        <p className="ac-text-caption ac-muted num">
          {t("orders.number", { number: order.number })} · {t(statusKey(order.status))}
          {order.isTest && ` · ${t("orders.mark.test")}`}
        </p>
        <p className="ac-text-heading found__item">
          {order.item.name.text} × {order.quantity}
        </p>
        {(order.item.brand || order.item.article) && (
          <p className="ac-text-body-s ac-muted">
            {[order.item.brand, order.item.article].filter(Boolean).join(" · ")}
          </p>
        )}
        <dl className="facts">
          {customerName !== null && (
            <div>
              <dt>{t("orders.customer")}</dt>
              <dd>{customerName || t("orders.customerNoName")}</dd>
            </div>
          )}
          <div>
            <dt>{t("orders.total")}</dt>
            <dd className="ac-text-body-strong">
              <Money value={order.total} />
            </dd>
          </div>
          {order.receiptOn && (
            <div>
              <dt>{t("orders.receiving")}</dt>
              <dd>{formatDate(order.receiptOn, lang)}</dd>
            </div>
          )}
        </dl>
        {late && (
          <Banner tone="warning">{t("scan.lateText", { when: when(late.expiredAt) })}</Banner>
        )}
        <div className="scanner__actions">
          <Button size="l" block onClick={onGiveOut}>
            {t(late ? "scan.closeOrder" : "scan.giveOut")}
          </Button>
          <Button size="l" variant="secondary" block onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function ResultPanel({
  result,
  from,
  when,
  companyName,
  onClose,
  onNext,
  onManual,
  onRetry,
  onSwitch,
}: {
  result: ScanResult;
  from: From;
  when: (iso: string) => string;
  companyName: string;
  onClose: () => void;
  onNext: () => void;
  onManual: () => void;
  onRetry: () => void;
  onSwitch: (supplierId: string) => Promise<void>;
}) {
  const t = useT();
  const tone = resultTone(result);
  const words = resultWords(result, when, t);
  const [switchFailed, setSwitchFailed] = useState(false);

  let main: ReactNode;
  if (result.kind === "otherSupplier" && result.supplier) {
    const target = result.supplier;
    main = (
      <Button
        size="l"
        block
        onClick={async () => {
          setSwitchFailed(false);
          try {
            await onSwitch(target.id);
          } catch {
            setSwitchFailed(true);
          }
        }}
      >
        {t("scan.switch")}
      </Button>
    );
  } else if (result.kind === "notFound" && from === "manual") {
    main = (
      <Button size="l" block onClick={onManual}>
        {t("scan.enterAgain")}
      </Button>
    );
  } else if (result.kind === "offline" && result.code) {
    main = (
      <Button size="l" block icon="refresh" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    );
  } else {
    main = (
      <Button size="l" block onClick={onNext}>
        {t("scan.next")}
      </Button>
    );
  }
  const showNext =
    main !== null &&
    ((result.kind === "otherSupplier" && result.supplier !== null) ||
      (result.kind === "notFound" && from === "manual") ||
      (result.kind === "offline" && result.code !== null));

  return (
    <Panel companyName={companyName} onClose={onClose} tone={tone}>
      <div className={`result result--${tone}`}>
        <div className="result__top">
          <div className="result__head">
            <Icon name={resultIcon(result)} size={48} />
            <h1 className="ac-text-title-l">{words.title}</h1>
          </div>
        </div>
        <div className="result__body">
          {words.text && <p className="ac-text-body">{words.text}</p>}
          {(result.kind === "offline" || result.kind === "unavailable") && result.code && (
            <p className="result__code ac-text-code-x-l">{shownCode(result.code)}</p>
          )}
          {switchFailed && <Banner tone="danger">{t("common.saveFailed")}</Banner>}
          <div className="scanner__actions">
            {main}
            {showNext && (
              <Button size="l" variant="secondary" block onClick={onNext}>
                {t("scan.next")}
              </Button>
            )}
            <Button size="l" variant="text" block onClick={() => navigate("orders")}>
              {t("scan.toOrders")}
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function CameraProblemPanel({
  problem,
  companyName,
  onClose,
  onManual,
  onRetry,
}: {
  problem: CameraProblem;
  companyName: string;
  onClose: () => void;
  onManual: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const title = {
    denied: "scan.camera.deniedTitle",
    noCamera: "scan.camera.noCameraTitle",
    busy: "scan.camera.busyTitle",
    insecure: "scan.camera.insecureTitle",
    unsupported: "scan.camera.unsupportedTitle",
    failed: "scan.camera.failedTitle",
  } as const;
  const text = {
    denied: "scan.camera.denied",
    noCamera: "scan.camera.noCamera",
    busy: "scan.camera.busy",
    insecure: "scan.camera.insecure",
    unsupported: "scan.camera.unsupported",
    failed: "scan.camera.failed",
  } as const;
  return (
    <Panel companyName={companyName} onClose={onClose}>
      <div className="camera-problem">
        <Icon name="cameraSlash" size={48} className="camera-problem__icon" />
        <h1 className="ac-text-title">{t(title[problem])}</h1>
        <p className="ac-text-body">{t(text[problem])}</p>
        {problem === "denied" && (
          <div className="camera-problem__help">
            <p className="ac-text-body-strong">{t("scan.camera.iphone")}</p>
            <p className="ac-text-body-s">{t("scan.camera.iphoneSteps")}</p>
            <p className="ac-text-body-s ac-muted">{t("scan.camera.iphoneHome")}</p>
            <p className="ac-text-body-strong">{t("scan.camera.android")}</p>
            <p className="ac-text-body-s">{t("scan.camera.androidSteps")}</p>
          </div>
        )}
        <div className="scanner__actions">
          <Button size="l" block icon="keyboard" onClick={onManual}>
            {t("scan.manual")}
          </Button>
          {problem !== "insecure" && problem !== "unsupported" && problem !== "noCamera" && (
            <Button size="l" variant="secondary" block icon="refresh" onClick={onRetry}>
              {t("scan.camera.retry")}
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
