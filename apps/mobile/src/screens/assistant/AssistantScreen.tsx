import {
  ASSISTANT_MESSAGE_MAX_CHARS,
  type AssistantCard,
  type AssistantComplaintReason,
  type AssistantLimits,
  type AssistantMessageResponse,
} from "@adclub/contracts";
import { randomUUID } from "expo-crypto";
import { layout } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  Dialog,
  IconButton,
  OfflineBanner,
  Screen,
  SelectButton,
  SkeletonList,
  Text,
  TextField,
  useLoadingGate,
  useTheme,
  useToast,
} from "../../design-system";
import {
  assistantCounter,
  assistantFailureOf,
  assistantLimitSheetOf,
  currentDialogOf,
  liveQuestionId,
  withCurrentDialog,
  type AssistantLimitSheet,
  type DialogEntry,
} from "../../assistant/assistant-rules";
import {
  answerCarOf,
  createAssistantTurns,
  loadDialog,
  mileageOfferOf,
  type Turn,
} from "../../assistant/assistant-turns";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { carTitle } from "../../garage/garage";
import { lowerThanLast, formatKm } from "../../garage/mileage";
import { useSignIn } from "../../navigation/use-sign-in";
import {
  complainAboutAnswer,
  readAssistantDialog,
  readAssistantLimits,
  sendAssistantMessage,
} from "../../services/assistant";
import { useOnline } from "../../services/use-network";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useGarage } from "../../state/garage-provider";
import { useLanguage } from "../../state/language";
import { assistantDialogsStore, sessionStore } from "../../state/stores";
import { CarSheet } from "../catalog/CarSheet";
import { garageErrorText } from "../garage/garage-errors";
import { Avatar, ReplyBlock, ThinkingRow, UserBubble } from "./AssistantMessages";
import { AssistantComplaintSheet, AssistantLimitSheetView } from "./AssistantSheets";

/** How many times, and how far apart, a dialog whose turn is still running is read again. */
const TURN_POLLS = 3;
const TURN_POLL_MS = 2000;

export interface AssistantScreenProps {
  /** A text to put into the field (a search, an article off a photo); `stamp` — each time anew. */
  draft?: { text: string; stamp: number };
  onOpenItem: (item: { id: string; name: string }) => void;
  onPhoto: () => void;
  onAddCar: () => void;
  onCatalog: () => void;
  onSearch: () => void;
}

/** What the screen says about the last attempt, under the dialog. */
type Notice =
  | { kind: "dialog_full" }
  | { kind: "wait"; minutes: number }
  | { kind: "send_failed" }
  | { kind: "car_gone" };

/** A message on its way, shown as the person's bubble. */
interface Pending {
  text: string;
}

function signedInAccount(): string | null {
  const session = sessionStore.get();
  return session.status === "signed_in" ? session.session.accountId : null;
}

/**
 * M-AI-01 (TASK-063; ARCHITECTURE 4.86): the dialog with AI Pilot for the
 * main car of the garage.
 *
 * The screen decides nothing the server decides. It sends the person's
 * words with the car (`assistantCarOf`) and the city, and shows the answer
 * as it came: the text, the quick replies, the cards (the catalog's rows,
 * to the catalog's card of the item — the order is made only there, D-074),
 * the groups of a service, the disclaimer, «недоступен». It keeps only the
 * current dialog's id on the device (a guest's and the account's apart) and
 * reads the dialog back from the server when it opens.
 *
 * «Остановить» stops waiting, not the turn: the server finishes it, and the
 * dialog is read again on the next opening or sending; a message refused
 * because a turn is still running reads it again a few times
 * (`TURN_POLLS`). A message that got no answer stays in the field.
 *
 * The order of requests — the epoch every reading and answer is checked
 * against, one new dialog a send, late answers — is `createAssistantTurns`
 * (TASK-063.A); what an answer says about a car is said of the dialog's
 * car (`answerCarOf`), not the header's.
 */
export function AssistantScreen({
  draft,
  onOpenItem,
  onPhoto,
  onAddCar,
  onCatalog,
  onSearch,
}: AssistantScreenProps) {
  const { t } = useLanguage();
  const { reduceMotion } = useTheme();
  const toast = useToast();
  const online = useOnline();
  const signIn = useSignIn();
  const { cars, recordMileage, sync } = useGarage();
  const { car, chooseCar } = useCatalogCar();
  const { selection } = useCity();
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  const accountId = session.status === "signed_in" ? session.session.accountId : null;
  const stored = useSyncExternalStore(assistantDialogsStore.subscribe, assistantDialogsStore.get);
  const current = currentDialogOf(stored, accountId);

  const [entries, setEntries] = useState<DialogEntry[]>([]);
  const [limits, setLimits] = useState<AssistantLimits | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // «Остановить» pressed: the message is on the server, its answer not waited for.
  const [stopped, setStopped] = useState<Pending | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [limitSheet, setLimitSheet] = useState<AssistantLimitSheet | null>(null);
  const [complaintFor, setComplaintFor] = useState<string | null>(null);
  const [complained, setComplained] = useState<ReadonlySet<string>>(new Set());
  const [mileageState, setMileageState] = useState<ReadonlyMap<string, "saving" | "saved">>(
    new Map(),
  );
  const [lower, setLower] = useState<{ km: number; last: number; messageId: string } | null>(null);
  const [sheet, setSheet] = useState<"car" | null>(null);
  const [confirmCar, setConfirmCar] = useState<string | null>(null);
  const gate = useLoadingGate();
  // The same functions for the life of the screen: `reload` stays one, and
  // the focus effect reads the dialog once, not again on every change of `gate`.
  const { begin: gateBegin, settle: gateSettle, cancel: gateCancel } = gate;
  const scroll = useRef<ScrollView>(null);
  // The epoch, the attempts and the opening of a new dialog (`assistant-turns.ts`).
  const [turns] = useState(() => createAssistantTurns(randomUUID));
  // The dialog was left before its answer came: read it again before anything else.
  const stale = useRef(false);
  const loadedFor = useRef<string | null>(null);
  // The dialog the shown messages are of: an answer of it adds to them.
  const shownDialog = useRef<string | null>(null);
  // The timers of the readings after ASSISTANT_TURN_IN_PROGRESS: off when the screen is left.
  const timers = useRef(new Set<{ timer: ReturnType<typeof setTimeout>; done: () => void }>());
  const pendingRef = useRef<Pending | null>(null);
  const shownCount = useRef(0);
  useEffect(() => {
    pendingRef.current = pending;
    shownCount.current = entries.length;
  }, [pending, entries]);

  const dialogId = current?.dialogId ?? null;
  const dialogCarId = current?.carId ?? null;
  const cityId = cityIdOf(selection);

  const remember = useCallback(
    (owner: string | null, dialog: { dialogId: string; carId: string } | null) => {
      assistantDialogsStore.set(withCurrentDialog(assistantDialogsStore.get(), owner, dialog));
    },
    [],
  );

  /** The dialog as the server keeps it; 404 — gone: an empty one. */
  // `null` — not read, or read for a dialog the screen has left (another epoch).
  // The epoch is checked when the answer comes and again when the indicator
  // lets it be shown; an answer of another epoch leaves the indicator to the
  // newer load (`loadDialog`, TASK-063.B).
  const reload = useCallback(
    async (id: string) => {
      const answer = await loadDialog(
        turns,
        { begin: gateBegin, settle: gateSettle },
        () => readAssistantDialog(id),
        (read) => {
          shownDialog.current = id;
          setEntries(read.messages);
          setLimits(read.limits);
          setStopped(null);
          stale.current = false;
        },
        (error) => {
          if (assistantFailureOf(error, true).kind === "dialog_gone") {
            remember(signedInAccount(), null);
            shownDialog.current = null;
            setEntries([]);
          }
        },
      );
      return answer ? answer.messages.length : null;
    },
    [gateBegin, gateSettle, remember, turns],
  );

  /** A pause between readings; `false` — the screen was left meanwhile. */
  const pause = useCallback(
    (ms: number) =>
      new Promise<boolean>((resolve) => {
        const entry = {
          timer: setTimeout(() => {
            timers.current.delete(entry);
            resolve(true);
          }, ms),
          done: () => resolve(false),
        };
        timers.current.add(entry);
      }),
    [],
  );
  /** Stops the pauses in progress; `true` — there were some. */
  const dropTimers = useCallback(() => {
    const some = timers.current.size > 0;
    for (const entry of timers.current) {
      clearTimeout(entry.timer);
      entry.done();
    }
    timers.current.clear();
    return some;
  }, []);
  useEffect(
    () => () => {
      dropTimers();
    },
    [dropTimers],
  );

  /** Moves the screen to a new epoch: whatever was asked before is dropped when it comes. */
  // The reading in the indicator is of the epoch left: cancelled, so its
  // answer, held for the indicator's minimum, is never shown (TASK-063.B).
  const advance = useCallback(() => {
    turns.advance();
    gateCancel();
    dropTimers();
    shownDialog.current = null;
    stale.current = false;
  }, [dropTimers, gateCancel, turns]);

  // Who uses the app changed: signing in opens the account's new dialog
  // (the guest's stays the guest's); the text in the field stays.
  const owner = useRef(accountId);
  useEffect(() => {
    if (owner.current === accountId) return;
    const signedIn = owner.current === null && accountId !== null;
    owner.current = accountId;
    advance();
    const unanswered = pendingRef.current;
    if (unanswered) setText((typed) => (typed === "" ? unanswered.text : typed));
    setPending(null);
    setStopped(null);
    setEntries([]);
    setLimits(null);
    setNotice(null);
    loadedFor.current = null;
    if (signedIn) remember(accountId, null);
  }, [accountId, advance, remember]);

  // The current dialog when the screen opens or the dialog changes.
  useEffect(() => {
    if (dialogId === null) {
      loadedFor.current = null;
      const turn = turns.begin();
      void readAssistantLimits()
        .then((read) => {
          if (turns.current(turn)) setLimits(read);
        })
        .catch(() => undefined);
      return;
    }
    if (loadedFor.current === dialogId) return;
    loadedFor.current = dialogId;
    void reload(dialogId);
  }, [dialogId, reload, turns]);

  // Back on the screen: an answer that came while it was closed is read.
  // Leaving it stops the readings after ASSISTANT_TURN_IN_PROGRESS; the
  // dialog is read again on coming back instead.
  useFocusEffect(
    useCallback(() => {
      if (stale.current && dialogId) void reload(dialogId);
    }, [dialogId, reload]),
  );
  useFocusEffect(
    useCallback(
      () => () => {
        if (dropTimers()) stale.current = true;
      },
      [dropTimers],
    ),
  );

  // A text to put into the field (the person sends it): each new stamp once.
  const [seenDraft, setSeenDraft] = useState<number | undefined>(undefined);
  if (draft && draft.stamp !== seenDraft) {
    setSeenDraft(draft.stamp);
    setText(draft.text.slice(0, ASSISTANT_MESSAGE_MAX_CHARS));
  }

  const startNewDialog = useCallback(() => {
    advance();
    remember(signedInAccount(), null);
    setEntries([]);
    setPending(null);
    setStopped(null);
    setNotice(null);
  }, [advance, remember]);

  const applied = (response: AssistantMessageResponse, sent: string, carId: string, turn: Turn) => {
    if (turns.mayRemember(turn)) {
      remember(signedInAccount(), { dialogId: response.dialogId, carId });
    }
    loadedFor.current = response.dialogId;
    // An answer of the shown dialog adds to it (after «Остановить» the
    // reading before the send has shown the earlier exchange).
    const same = shownDialog.current === response.dialogId;
    shownDialog.current = response.dialogId;
    setEntries((now) => [
      ...(same ? now : []),
      {
        id: `local-${response.message.id}`,
        role: "user",
        createdAt: response.message.createdAt,
        text: sent,
      },
      response.message,
    ]);
    setLimits(response.limits);
    setPending(null);
    const reply = response.message;
    if (reply.kind === "unavailable") {
      // Not spent: the words wait in the field to be sent again.
      setText((typed) => (typed === "" ? sent : typed));
      const sheetOf = assistantLimitSheetOf(reply);
      if (sheetOf) setLimitSheet(sheetOf);
    }
  };

  const send = async (raw: string, quickReply = false) => {
    const message = raw.trim();
    if (message === "" || pending !== null || !online) return;
    const turn = turns.begin();
    const who = signedInAccount();
    let before = shownCount.current;
    setNotice(null);
    setPending({ text: message });
    if (!quickReply) setText("");
    const back = () => {
      if (!quickReply) setText((typed) => (typed === "" ? message : typed));
    };
    const storedDialog = () => currentDialogOf(assistantDialogsStore.get(), who);
    // One new dialog a send: a send still opening one (also after
    // «Остановить») is waited for, and this one goes into its dialog.
    let target = await turns.dialogFor(turn, storedDialog()?.dialogId ?? null);
    if (!turns.current(turn)) {
      if (target.kind === "open") target.settle(null);
      return;
    }
    if (target.kind === "dialog" && stale.current) {
      // An answer came while it was not waited for: the dialog first.
      before = (await reload(target.dialogId)) ?? before;
      if (!turns.current(turn)) return;
      const now = storedDialog()?.dialogId ?? null;
      if (now === null) target = await turns.dialogFor(turn, null);
      if (!turns.current(turn)) {
        if (target.kind === "open") target.settle(null);
        return;
      }
    }
    const opening = target.kind === "open" ? target.settle : null;
    const forDialog = target.kind === "dialog" ? target.dialogId : null;
    // The car of the request: the dialog's (the server keeps it), else the header's.
    const stored = forDialog ? storedDialog() : null;
    const known = stored?.dialogId === forDialog ? stored : null;
    const dialogCar = known ? answerCarOf(cars, known.carId) : null;
    const forCar = dialogCar ?? car;
    const carId = known?.carId ?? forCar.id;
    // The dialog's car is gone from the garage: the server keeps the dialog's
    // car, and the header's mileage is not its (TASK-063.B).
    const withMileage = known === null || dialogCar !== null;
    try {
      const response = await sendAssistantMessage({
        text: message,
        car: forCar,
        cityId,
        dialogId: forDialog,
        ...(target.kind === "open" ? { openKey: target.openKey } : {}),
        withMileage,
        quickReply,
      });
      opening?.(response.dialogId);
      if (!turns.current(turn)) return;
      if (!turns.awaited(turn)) {
        // Stopped meanwhile: the dialog is known now, its answer is read on
        // the next opening or sending.
        if (forDialog === null && turns.mayRemember(turn)) {
          remember(who, { dialogId: response.dialogId, carId });
        }
        stale.current = true;
        return;
      }
      applied(response, message, carId, turn);
      // Sent again with the key of a send whose answer was lost: that send's
      // exchange is in the dialog too, so the dialog is read whole (TASK-063.B).
      if (target.kind === "open" && target.resent) void reload(response.dialogId);
    } catch (error) {
      opening?.(null);
      if (!turns.awaited(turn)) return;
      const failure = assistantFailureOf(error, forDialog !== null);
      setPending(null);
      back();
      switch (failure.kind) {
        case "in_progress": {
          // The turn before is still running (after «Остановить»): read the dialog a few times.
          if (!forDialog) return;
          for (let poll = 0; poll < TURN_POLLS; poll += 1) {
            if (!(await pause(TURN_POLL_MS)) || !turns.current(turn)) return;
            const now = await reload(forDialog);
            if (!turns.current(turn)) return;
            if (now !== null && now > before) return;
          }
          stale.current = true;
          return;
        }
        case "dialog_full":
          setNotice({ kind: "dialog_full" });
          return;
        case "wait":
          setNotice({ kind: "wait", minutes: failure.minutes });
          return;
        case "car_gone":
          // Deleted on another device: the garage is read again, its main car comes next.
          void sync().catch(() => undefined);
          setNotice({ kind: "car_gone" });
          return;
        case "dialog_gone":
          remember(who, null);
          shownDialog.current = null;
          setEntries([]);
          return;
        case "guest_trial":
        case "guest_budget":
        case "day":
          setLimitSheet(failure.kind);
          return;
        default:
          setNotice({ kind: "send_failed" });
      }
    }
  };

  // The input comes back at once; the message stays shown, muted, until the dialog is read again.
  const stop = () => {
    turns.stop();
    stale.current = true;
    setStopped(pending);
    setPending(null);
  };

  // The car the answers of the shown dialog were given for (not the header's).
  const answerCar = useMemo(() => answerCarOf(cars, dialogCarId), [cars, dialogCarId]);

  const updateMileage = async (messageId: string, km: number, confirmLower = false) => {
    const target = answerCar;
    if (!target || mileageState.get(messageId) === "saving") return;
    const mark = (state: "saving" | "saved" | null) =>
      setMileageState((now) => {
        const next = new Map(now);
        if (state) next.set(messageId, state);
        else next.delete(messageId);
        return next;
      });
    mark("saving");
    try {
      await recordMileage(target.id, { valueKm: km, source: "text" }, confirmLower);
      mark("saved");
    } catch (error) {
      mark(null);
      const last = lowerThanLast(error);
      if (last !== null) {
        setLower({ km, last, messageId });
        return;
      }
      toast.show(garageErrorText(error, t));
    }
  };

  const complain = async (reason: AssistantComplaintReason, words: string) => {
    if (!complaintFor) return;
    await complainAboutAnswer(complaintFor, reason, words);
    setComplained((now) => new Set(now).add(complaintFor));
    setComplaintFor(null);
    toast.show(t("assistant.complaintThanks"));
  };

  const pickCar = (carId: string) => {
    if (carId === car.id) return;
    if (entries.length > 0 || pending || stopped) setConfirmCar(carId);
    else void chooseCar(carId);
  };

  const live = liveQuestionId(entries);
  const counter = assistantCounter(limits);
  const firstReply = entries.find((entry) => entry.role === "assistant")?.id ?? null;
  const otherCar = entries.length > 0 && current !== null && current.carId !== car.id;
  const empty = entries.length === 0 && pending === null && stopped === null;
  const loading = gate.indicator && entries.length === 0;
  const confirmName = confirmCar
    ? carTitle(cars.find((item) => item.id === confirmCar) ?? car)
    : "";

  let noticeView: ReactNode = null;
  if (notice?.kind === "dialog_full") {
    noticeView = (
      <Banner
        tone="warning"
        action={
          <Button variant="text" size="m" onPress={startNewDialog}>
            {t("assistant.newDialog")}
          </Button>
        }
      >
        {t("assistant.dialogFull")}
      </Banner>
    );
  } else if (notice?.kind === "wait") {
    noticeView = <Banner tone="warning">{t("assistant.wait", { minutes: notice.minutes })}</Banner>;
  } else if (notice?.kind === "car_gone") {
    noticeView = (
      <Banner
        tone="warning"
        action={
          <Button variant="text" size="m" onPress={startNewDialog}>
            {t("assistant.newDialog")}
          </Button>
        }
      >
        {t("assistant.carGone")}
      </Banner>
    );
  } else if (notice?.kind === "send_failed") {
    noticeView = <Banner tone="danger">{t("assistant.sendFailed")}</Banner>;
  }

  return (
    <Screen
      title={t("assistant.name")}
      root
      scroll={false}
      actions={
        <IconButton
          icon="plusSquare"
          label={t("assistant.newDialog")}
          onPress={startNewDialog}
          disabled={empty}
        />
      }
      banner={!online ? <OfflineBanner label={t("garage.needsNetwork")} /> : null}
      header={
        <View style={styles.header}>
          <SelectButton
            icon="car"
            accessibilityLabel={t("catalog.carLabel")}
            onPress={() => setSheet("car")}
          >
            {carTitle(car)}
          </SelectButton>
        </View>
      }
    >
      <ScrollView
        ref={scroll}
        style={styles.flex}
        contentContainerStyle={[styles.content, empty && styles.contentEmpty]}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: !reduceMotion })}
      >
        {loading ? (
          <SkeletonList rows={3} label={t("common.loading")} />
        ) : empty ? (
          <View style={styles.welcome}>
            <Avatar state="idle" />
            <Text variant="title" style={styles.center}>
              {t("assistant.empty")}
            </Text>
            <View style={styles.examples}>
              {(["assistant.example1", "assistant.example2", "assistant.example3"] as const).map(
                (key) => (
                  <Button
                    key={key}
                    variant="secondary"
                    disabled={!online}
                    onPress={() => void send(t(key))}
                  >
                    {t(key)}
                  </Button>
                ),
              )}
            </View>
          </View>
        ) : (
          <>
            {otherCar && (
              <Banner
                action={
                  <Button variant="text" size="m" onPress={startNewDialog}>
                    {t("assistant.newDialog")}
                  </Button>
                }
              >
                {answerCar
                  ? t("assistant.otherCar", { car: carTitle(answerCar) })
                  : t("assistant.dialogCarRemoved")}
              </Banner>
            )}
            {entries.map((entry) =>
              entry.role === "user" ? (
                <UserBubble key={entry.id} text={entry.text} />
              ) : (
                <ReplyBlock
                  key={entry.id}
                  reply={entry}
                  carName={answerCar ? carTitle(answerCar) : null}
                  modelName={answerCar?.model.label ?? null}
                  live={entry.id === live && pending === null}
                  online={online}
                  first={entry.id === firstReply}
                  complained={complained.has(entry.id)}
                  mileage={mileageOfferOf(
                    entry.mileageSuggestion,
                    answerCar,
                    mileageState.get(entry.id) ?? null,
                  )}
                  onQuickReply={(option) => void send(option, true)}
                  onOpenCard={(card: AssistantCard) =>
                    onOpenItem({ id: card.id, name: card.name.text })
                  }
                  onComplain={() => setComplaintFor(entry.id)}
                  onUpdateMileage={(km) => updateMileage(entry.id, km)}
                  onSearch={onSearch}
                />
              ),
            )}
            {stopped && (
              <>
                <UserBubble text={stopped.text} muted />
                <Text variant="caption" color="textMuted">
                  {t("assistant.stopped")}
                </Text>
              </>
            )}
            {pending && <UserBubble text={pending.text} />}
            {pending && <ThinkingRow onStop={stop} />}
          </>
        )}
        {noticeView}
      </ScrollView>

      <View style={styles.input}>
        {counter && (
          <Text variant="caption" color="textMuted">
            {counter.scope === "guest"
              ? t("assistant.leftGuest", { n: counter.left })
              : t("assistant.leftAccount", { n: counter.left })}
          </Text>
        )}
        <TextField
          label={t("assistant.field")}
          placeholder={t("assistant.placeholder")}
          value={text}
          onChangeText={setText}
          multiline
          grows
          maxLength={ASSISTANT_MESSAGE_MAX_CHARS}
          disabled={!online}
          {...(text.length > ASSISTANT_MESSAGE_MAX_CHARS - 100
            ? {
                counter: {
                  count: text.length,
                  max: ASSISTANT_MESSAGE_MAX_CHARS,
                  text: t("feedback.counter", {
                    n: text.length,
                    max: ASSISTANT_MESSAGE_MAX_CHARS,
                  }),
                },
              }
            : {})}
          trailing={
            <IconButton
              icon="camera"
              label={t("partPhoto.open")}
              onPress={onPhoto}
              disabled={!online}
            />
          }
        />
        <View style={styles.sendRow}>
          <Button
            size="m"
            align="start"
            disabled={!online || pending !== null || text.trim() === ""}
            onPress={() => void send(text)}
          >
            {t("assistant.send")}
          </Button>
        </View>
      </View>

      <CarSheet
        visible={sheet === "car"}
        onClose={() => setSheet(null)}
        onPickCar={pickCar}
        onAddCar={onAddCar}
      />
      <Dialog
        visible={confirmCar !== null}
        onClose={() => setConfirmCar(null)}
        title={t("assistant.newDialogFor", { car: confirmName })}
        actions={
          <>
            <Button
              onPress={async () => {
                const chosen = confirmCar;
                setConfirmCar(null);
                if (!chosen) return;
                startNewDialog();
                await chooseCar(chosen);
              }}
            >
              {t("assistant.newDialogConfirm")}
            </Button>
            <Button variant="secondary" onPress={() => setConfirmCar(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <Text color="textMuted">{t("assistant.newDialogText")}</Text>
      </Dialog>
      <Dialog
        visible={lower !== null}
        onClose={() => setLower(null)}
        title={t("mileage.lowerTitle", { value: formatKm(lower?.last ?? 0) })}
        actions={
          <>
            <Button
              onPress={async () => {
                const asked = lower;
                setLower(null);
                if (asked) await updateMileage(asked.messageId, asked.km, true);
              }}
            >
              {t("mileage.lowerConfirm")}
            </Button>
            <Button variant="secondary" onPress={() => setLower(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      />
      <AssistantLimitSheetView
        sheet={limitSheet}
        onClose={() => setLimitSheet(null)}
        onSignIn={signIn.start}
        onCatalog={onCatalog}
      />
      <AssistantComplaintSheet
        visible={complaintFor !== null}
        online={online}
        onClose={() => setComplaintFor(null)}
        onSend={complain}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: layout.screenPadding, paddingTop: 4, flexDirection: "row" },
  content: {
    paddingHorizontal: layout.screenPadding,
    paddingVertical: 16,
    gap: 16,
  },
  contentEmpty: { flexGrow: 1, justifyContent: "center" },
  welcome: { alignItems: "center", gap: 16 },
  center: { textAlign: "center" },
  examples: { alignSelf: "stretch", gap: 8 },
  input: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
  },
  sendRow: { flexDirection: "row", justifyContent: "flex-end" },
});
