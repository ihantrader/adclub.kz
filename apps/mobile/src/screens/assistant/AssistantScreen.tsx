import {
  ASSISTANT_MESSAGE_MAX_CHARS,
  type AssistantCard,
  type AssistantComplaintReason,
  type AssistantLimits,
  type AssistantMessageResponse,
} from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import {
  useCallback,
  useEffect,
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const [savedMileage, setSavedMileage] = useState<ReadonlySet<string>>(new Set());
  const [lower, setLower] = useState<{ km: number; last: number; messageId: string } | null>(null);
  const [sheet, setSheet] = useState<"car" | null>(null);
  const [confirmCar, setConfirmCar] = useState<string | null>(null);
  const gate = useLoadingGate();
  const scroll = useRef<ScrollView>(null);
  // A send in flight, numbered: «Остановить» and a new dialog stop waiting for it.
  const attempt = useRef(0);
  // The dialog was left before its answer came: read it again before anything else.
  const stale = useRef(false);
  const loadedFor = useRef<string | null>(null);
  // The current dialog of this screen, numbered: a new dialog or another
  // person moves it on, and an answer that comes late for an earlier one
  // never brings that dialog back.
  const epoch = useRef(0);
  const pendingRef = useRef<Pending | null>(null);
  const shownCount = useRef(0);
  useEffect(() => {
    pendingRef.current = pending;
    shownCount.current = entries.length;
  }, [pending, entries]);

  const dialogId = current?.dialogId ?? null;
  const cityId = cityIdOf(selection);

  const remember = useCallback(
    (owner: string | null, dialog: { dialogId: string; carId: string } | null) => {
      assistantDialogsStore.set(withCurrentDialog(assistantDialogsStore.get(), owner, dialog));
    },
    [],
  );

  /** The dialog as the server keeps it; 404 — gone: an empty one. */
  const reload = useCallback(
    async (id: string) => {
      const ticket = gate.begin();
      try {
        const answer = await readAssistantDialog(id);
        gate.settle(ticket, () => {
          setEntries(answer.messages);
          setLimits(answer.limits);
          setStopped(null);
          stale.current = false;
        });
        return answer.messages.length;
      } catch (error) {
        gate.cancel();
        if (assistantFailureOf(error, true).kind === "dialog_gone") {
          remember(signedInAccount(), null);
          setEntries([]);
        }
        return null;
      }
    },
    [gate, remember],
  );

  // Who uses the app changed: signing in opens the account's new dialog
  // (the guest's stays the guest's); the text in the field stays.
  const owner = useRef(accountId);
  useEffect(() => {
    if (owner.current === accountId) return;
    const signedIn = owner.current === null && accountId !== null;
    owner.current = accountId;
    attempt.current += 1;
    epoch.current += 1;
    const unanswered = pendingRef.current;
    if (unanswered) setText((typed) => (typed === "" ? unanswered.text : typed));
    setPending(null);
    setStopped(null);
    setEntries([]);
    setLimits(null);
    setNotice(null);
    loadedFor.current = null;
    if (signedIn) remember(accountId, null);
  }, [accountId, remember]);

  // The current dialog when the screen opens or the dialog changes.
  useEffect(() => {
    if (dialogId === null) {
      loadedFor.current = null;
      void readAssistantLimits()
        .then(setLimits)
        .catch(() => undefined);
      return;
    }
    if (loadedFor.current === dialogId) return;
    loadedFor.current = dialogId;
    void reload(dialogId);
  }, [dialogId, reload]);

  // Back on the screen: an answer that came while it was closed is read.
  useFocusEffect(
    useCallback(() => {
      if (stale.current && dialogId) void reload(dialogId);
    }, [dialogId, reload]),
  );

  // A text to put into the field (the person sends it): each new stamp once.
  const [seenDraft, setSeenDraft] = useState<number | undefined>(undefined);
  if (draft && draft.stamp !== seenDraft) {
    setSeenDraft(draft.stamp);
    setText(draft.text.slice(0, ASSISTANT_MESSAGE_MAX_CHARS));
  }

  const startNewDialog = useCallback(() => {
    attempt.current += 1;
    epoch.current += 1;
    remember(signedInAccount(), null);
    setEntries([]);
    setPending(null);
    setStopped(null);
    setNotice(null);
    stale.current = false;
  }, [remember]);

  const applied = (response: AssistantMessageResponse, sent: string, carId: string) => {
    remember(signedInAccount(), { dialogId: response.dialogId, carId });
    loadedFor.current = response.dialogId;
    setEntries((now) => [
      ...(response.dialogId === dialogId ? now : []),
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
    const mine = ++attempt.current;
    const ofEpoch = epoch.current;
    const who = signedInAccount();
    const forCar = car;
    let forDialog = dialogId;
    let before = shownCount.current;
    setNotice(null);
    setPending({ text: message });
    if (!quickReply) setText("");
    const back = () => {
      if (!quickReply) setText((typed) => (typed === "" ? message : typed));
    };
    try {
      if (stale.current && forDialog) {
        before = (await reload(forDialog)) ?? before;
        forDialog = currentDialogOf(assistantDialogsStore.get(), who)?.dialogId ?? null;
      }
      const response = await sendAssistantMessage({
        text: message,
        car: forCar,
        cityId,
        dialogId: forDialog,
        quickReply,
      });
      if (mine !== attempt.current) {
        // Stopped meanwhile: the dialog is known now, its answer is read on the
        // next opening or sending — unless the person has moved on to another
        // dialog, or another person uses the app now.
        if (ofEpoch !== epoch.current || who !== signedInAccount()) return;
        if (forDialog === null) {
          remember(who, { dialogId: response.dialogId, carId: forCar.id });
        }
        stale.current = true;
        return;
      }
      applied(response, message, forCar.id);
    } catch (error) {
      if (mine !== attempt.current) return;
      const failure = assistantFailureOf(error, forDialog !== null);
      setPending(null);
      back();
      switch (failure.kind) {
        case "in_progress": {
          // The turn before is still running (after «Остановить»): read the dialog a few times.
          if (!forDialog) return;
          for (let poll = 0; poll < TURN_POLLS; poll += 1) {
            await wait(TURN_POLL_MS);
            if (mine !== attempt.current) return;
            const now = await reload(forDialog);
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
          remember(signedInAccount(), null);
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
    attempt.current += 1;
    stale.current = true;
    setStopped(pending);
    setPending(null);
  };

  const updateMileage = async (messageId: string, km: number, confirmLower = false) => {
    try {
      await recordMileage(car.id, { valueKm: km, source: "text" }, confirmLower);
      setSavedMileage((now) => new Set(now).add(messageId));
    } catch (error) {
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
  const dialogCar = current ? cars.find((item) => item.id === current.carId) : undefined;
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
                {t("assistant.otherCar", {
                  car: dialogCar ? carTitle(dialogCar) : t("garage.add"),
                })}
              </Banner>
            )}
            {entries.map((entry) =>
              entry.role === "user" ? (
                <UserBubble key={entry.id} text={entry.text} />
              ) : (
                <ReplyBlock
                  key={entry.id}
                  reply={entry}
                  carName={carTitle(car)}
                  modelName={car.model.label}
                  live={entry.id === live && pending === null}
                  online={online}
                  first={entry.id === firstReply}
                  complained={complained.has(entry.id)}
                  mileage={
                    entry.mileageSuggestion
                      ? savedMileage.has(entry.id)
                        ? "saved"
                        : car.mileage?.valueKm === entry.mileageSuggestion.km
                          ? null
                          : "ask"
                      : null
                  }
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
