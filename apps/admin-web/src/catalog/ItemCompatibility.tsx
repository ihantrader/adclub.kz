import type {
  AdminCatalogItemCard,
  AdminCompatibilityCheckResponse,
  AdminCompatibilityProposal,
  AdminCompatibilityRecord,
  AdminItemCompatibilityResponse,
} from "@adclub/contracts";
import {
  ActionBar,
  AiBadge,
  Banner,
  Button,
  Chip,
  CompatibilityMark,
  Dialog,
  EmptyState,
  LoadingContent,
  MenuButton,
  SkeletonList,
  StatusBadge,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { Table } from "../layout/layout";
import { useLoad } from "../use-load";
import {
  COMPATIBILITY_LEVEL_TEXT,
  COMPATIBILITY_RESULT_TEXT,
  catalogErrorText,
  conflictText,
  errorField,
  isConflict,
} from "./catalog-words";
import { whoChanged } from "./shared";
import { ruText } from "./values";
import {
  EMPTY_CHOICE,
  VehicleFields,
  choiceOf,
  conditionsOf,
  labelText,
  vehicleOf,
  type VehicleChoice,
} from "./VehicleFields";

const SOURCE_TEXT: Record<AdminCompatibilityRecord["source"], string> = {
  admin: "Администратор",
  supplier: "Предложение поставщика",
  ai: "ИИ",
  copy: "Копия с аналога",
};

const RECORD_COLUMNS = [
  { key: "cars", header: "Автомобили" },
  { key: "evidence", header: "Основание", width: 176 },
  { key: "source", header: "Откуда", width: 136 },
  { key: "actions", header: "Действия", actions: true, hiddenHeader: true, width: 168 },
];

const PROPOSAL_COLUMNS = [
  { key: "cars", header: "Автомобили" },
  { key: "evidence", header: "Основание", width: 156 },
  { key: "supplier", header: "Поставщик", width: 136 },
  { key: "actions", header: "Действия", actions: true, hiddenHeader: true, width: 188 },
];

/** Where a record came from; an AI one carries the AI mark (DESIGN 7.9). */
function SourceMark({ source }: { source: AdminCompatibilityRecord["source"] }) {
  if (source === "ai") return <AiBadge>ИИ</AiBadge>;
  return <span className="ac-text-body-s">{SOURCE_TEXT[source]}</span>;
}

type Editor =
  | { kind: "create" }
  | { kind: "edit"; record: AdminCompatibilityRecord }
  | { kind: "approve"; proposal: AdminCompatibilityProposal };

/**
 * «Совместимость» of the card (A-CAT-05; TASK-015 on the server): the
 * approved records with their conditions chosen from the vehicle catalog
 * and their grounds — create, change with the version, archive, copy from
 * an analog; the proposals of suppliers waiting for review — approve as
 * they are or corrected, reject with a reason; and the check of a car: the
 * result of the server's one calculation, never the admin panel's own.
 */
export function ItemCompatibility({ card }: { card: AdminCatalogItemCard }) {
  const toast = useToast();
  const online = useOnline();
  const itemId = card.item.id;
  const [withArchive, setWithArchive] = useState(false);
  const data = useLoad<AdminItemCompatibilityResponse>(
    () =>
      apiClient.getItemCompatibility(
        { itemId },
        { query: { includeArchived: withArchive ? "true" : "false" } },
      ),
    `compatibility:${itemId}:${withArchive}`,
  );
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [archiving, setArchiving] = useState<AdminCompatibilityRecord | null>(null);
  const [rejecting, setRejecting] = useState<AdminCompatibilityProposal | null>(null);
  const [reason, setReason] = useState("");
  const analogs = card.analogs.filter((analog) => analog.item.type !== "service");
  const records = data.data?.records ?? [];
  const proposals = data.data?.proposals ?? [];

  const act = async <T,>(
    action: () => Promise<T>,
    done: string | ((answer: T) => string),
    conflictOf?: [string, string],
  ) => {
    setError(null);
    try {
      const answer = await action();
      toast.show(typeof done === "string" ? done : done(answer));
      data.reload();
    } catch (thrown) {
      setError(
        isConflict(thrown) && conflictOf
          ? { text: conflictText(await whoChanged(conflictOf[0], conflictOf[1])), conflict: true }
          : { text: catalogErrorText(thrown), conflict: false },
      );
      data.reload();
    }
  };

  const copy = async (fromItemId: string) => {
    setError(null);
    try {
      const answer = await apiClient.copyCompatibility({ itemId }, { fromItemId });
      toast.show(
        `Скопировано записей: ${answer.created}${answer.alreadyPresent ? `, уже были: ${answer.alreadyPresent}` : ""}`,
      );
    } catch (thrown) {
      setError({ text: catalogErrorText(thrown), conflict: false });
    }
    data.reload();
  };

  return (
    <div className="detail-stack">
      {error && (
        <Banner
          tone="warning"
          action={
            error.conflict ? (
              <Button
                variant="text"
                size="s"
                onClick={() => {
                  setError(null);
                  data.reload();
                }}
              >
                Обновить данные
              </Button>
            ) : undefined
          }
        >
          {error.text}
        </Banner>
      )}
      {data.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={data.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(data.error)}
        </Banner>
      )}
      <LoadingContent
        ready={data.data !== undefined}
        indicator={data.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        <div className="cat-sections">
          <section className="section">
            <div className="section__head">
              <h3 className="section__title">Подтверждённые записи</h3>
              <span className="row-actions">
                <Chip selected={withArchive} onClick={() => setWithArchive(!withArchive)}>
                  С архивом
                </Chip>
                {analogs.length > 0 && (
                  <span className="cat-copy">
                    <MenuButton
                      text="Скопировать с аналога"
                      label="Скопировать записи с аналога"
                      disabled={!online}
                      actions={analogs.map((analog) => ({
                        key: analog.item.id,
                        label: [
                          analog.item.brand?.name,
                          analog.item.article,
                          ruText(analog.item.names),
                        ]
                          .filter(Boolean)
                          .join(" · "),
                        icon: "copy" as const,
                        onSelect: () => void copy(analog.item.id),
                      }))}
                    />
                  </span>
                )}
                <Button
                  variant="secondary"
                  size="s"
                  icon="plus"
                  disabled={!online}
                  onClick={() => setEditor({ kind: "create" })}
                >
                  Добавить запись
                </Button>
              </span>
            </div>
            {card.category.compatibilityRequired &&
              records.every((record) => record.status !== "approved") && (
                <Banner tone="warning">
                  В этой подкатегории совместимость обязательна: без записи клиенты не видят позицию
                  ни для одного автомобиля.
                </Banner>
              )}
            {records.length === 0 ? (
              <EmptyState
                compact
                icon="car"
                title="Записей нет"
                text="Добавьте автомобили, которым подходит позиция, или скопируйте записи с аналога"
              />
            ) : (
              <Table label="Подтверждённые записи совместимости" columns={RECORD_COLUMNS}>
                {records.map((record) => (
                  <tr
                    key={record.id}
                    className={record.status === "archived" ? "row--muted" : undefined}
                  >
                    <td>
                      <div className="cell-stack">
                        <span className="long-text ac-text-body-strong">
                          {labelText(record.label)}
                        </span>
                        {record.status === "archived" && (
                          <StatusBadge kind="compatibilityRecord" status="archived">
                            В архиве
                          </StatusBadge>
                        )}
                      </div>
                    </td>
                    <td className="ac-text-body-s long-text">{record.evidence}</td>
                    <td>
                      <div className="cell-stack">
                        <SourceMark source={record.source} />
                        <span className="ac-text-caption ac-muted nowrap">
                          {formatMoment(record.updatedAt)}
                        </span>
                      </div>
                    </td>
                    <td className="admin-table__actions">
                      {record.status === "approved" && (
                        <span className="row-actions">
                          <Button
                            variant="secondary"
                            size="s"
                            disabled={!online}
                            onClick={() => setEditor({ kind: "edit", record })}
                          >
                            Изменить
                          </Button>
                          <MenuButton
                            size="s"
                            label={`Действия: ${labelText(record.label)}`}
                            actions={[
                              {
                                key: "archive",
                                label: "В архив…",
                                icon: "archive",
                                destructive: true,
                                disabled: !online,
                                onSelect: () => setArchiving(record),
                              },
                            ]}
                          />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </section>

          <section className="section">
            <div className="section__head">
              <h3 className="section__title">Предложения поставщиков на рассмотрении</h3>
            </div>
            {proposals.length === 0 ? (
              <EmptyState
                compact
                icon="store"
                title="Предложений нет"
                text="Здесь появятся данные о совместимости, которые предложат поставщики"
              />
            ) : (
              <Table label="Предложения поставщиков" columns={PROPOSAL_COLUMNS}>
                {proposals.map((proposal) => (
                  <tr key={proposal.id}>
                    <td>
                      <div className="cell-stack">
                        <span className="long-text ac-text-body-strong">
                          {labelText(proposal.label)}
                        </span>
                        {proposal.matchesRecordId && (
                          <span className="ac-text-caption ac-muted">
                            Такая запись уже подтверждена — подтверждение ничего не добавит
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="ac-text-body-s long-text">{proposal.evidence}</td>
                    <td>
                      <div className="cell-stack">
                        <span className="ac-text-body-s">{proposal.supplier?.name ?? "—"}</span>
                        <span className="ac-text-caption ac-muted nowrap">
                          {formatMoment(proposal.createdAt)}
                        </span>
                      </div>
                    </td>
                    <td className="admin-table__actions">
                      <span className="row-actions">
                        <Button
                          variant="secondary"
                          size="s"
                          disabled={!online}
                          onClick={() =>
                            act(
                              () =>
                                apiClient.approveCompatibilityProposal(
                                  { proposalId: proposal.id },
                                  {},
                                ),
                              (answer) =>
                                answer.proposal.resolution === "already_approved"
                                  ? "Такая запись уже подтверждена — предложение закрыто без дубля"
                                  : "Предложение подтверждено",
                              ["item_compatibility_proposal", proposal.id],
                            )
                          }
                        >
                          Подтвердить
                        </Button>
                        <MenuButton
                          size="s"
                          label={`Действия: ${labelText(proposal.label)}`}
                          actions={[
                            {
                              key: "edit",
                              label: "Подтвердить с правкой…",
                              icon: "check",
                              disabled: !online,
                              onSelect: () => setEditor({ kind: "approve", proposal }),
                            },
                            {
                              key: "reject",
                              label: "Отклонить…",
                              icon: "prohibit",
                              destructive: true,
                              disabled: !online,
                              onSelect: () => {
                                setReason("");
                                setRejecting(proposal);
                              },
                            },
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </section>
        </div>
      </LoadingContent>

      <CompatibilityCheck itemId={itemId} />

      <RecordDialog
        itemId={itemId}
        editor={editor}
        onCancel={() => setEditor(null)}
        onDone={(text) => {
          setEditor(null);
          toast.show(text);
          data.reload();
        }}
      />
      <Dialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title="Убрать запись совместимости?"
        actions={
          <>
            <Button
              onClick={async () => {
                const record = archiving;
                setArchiving(null);
                if (record) {
                  await act(
                    () =>
                      apiClient.archiveCompatibilityRecord(
                        { recordId: record.id },
                        { expectedVersion: record.version },
                      ),
                    "Запись в архиве",
                    ["item_compatibility", record.id],
                  );
                }
              }}
            >
              В архив
            </Button>
            <Button variant="secondary" onClick={() => setArchiving(null)}>
              Отмена
            </Button>
          </>
        }
      >
        {archiving && (
          <p className="ac-text-body-s">
            «{labelText(archiving.label)}» перестанет действовать: для этих автомобилей позиция
            будет «совместимость не указана»
            {card.category.compatibilityRequired
              ? " и пропадёт из списков, если других записей нет"
              : ""}
            . Запись останется в истории.
          </p>
        )}
      </Dialog>
      <Dialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Отклонить предложение?"
        actions={
          <>
            <Button
              disabled={!reason.trim()}
              onClick={async () => {
                const proposal = rejecting;
                setRejecting(null);
                if (proposal) {
                  await act(
                    () =>
                      apiClient.rejectCompatibilityProposal(
                        { proposalId: proposal.id },
                        { reason: reason.trim() },
                      ),
                    "Предложение отклонено",
                    ["item_compatibility_proposal", proposal.id],
                  );
                }
              }}
            >
              Отклонить
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(null)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <TextField
            label="Причина"
            value={reason}
            onChange={setReason}
            hint="Её увидит поставщик"
          />
        </div>
      </Dialog>
    </div>
  );
}

function RecordDialog({
  itemId,
  editor,
  onCancel,
  onDone,
}: {
  itemId: string;
  editor: Editor | null;
  onCancel: () => void;
  onDone: (text: string) => void;
}) {
  const [shown, setShown] = useState<Editor | null>(null);
  const [choice, setChoice] = useState<VehicleChoice>(EMPTY_CHOICE);
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<{ text: string; field: string | null } | null>(null);
  if (editor !== shown) {
    setShown(editor);
    setError(null);
    if (editor?.kind === "edit") {
      setChoice(choiceOf(editor.record.conditions));
      setEvidence(editor.record.evidence);
    } else if (editor?.kind === "approve") {
      setChoice(choiceOf(editor.proposal.conditions));
      setEvidence(editor.proposal.evidence);
    } else {
      setChoice(EMPTY_CHOICE);
      setEvidence("");
    }
  }

  const submit = async () => {
    if (!editor) return;
    if (!choice.makeId) {
      setError({ text: "Марка обязательна", field: "makeId" });
      return;
    }
    if (!evidence.trim()) {
      setError({ text: "Укажите основание: каталог, ссылку или документ", field: "evidence" });
      return;
    }
    const conditions = conditionsOf(choice);
    try {
      if (editor.kind === "create") {
        await apiClient.createCompatibilityRecord(
          { itemId },
          { conditions, evidence: evidence.trim() },
        );
        onDone("Запись добавлена");
      } else if (editor.kind === "edit") {
        await apiClient.updateCompatibilityRecord(
          { recordId: editor.record.id },
          { expectedVersion: editor.record.version, conditions, evidence: evidence.trim() },
        );
        onDone("Запись изменена");
      } else {
        const answer = await apiClient.approveCompatibilityProposal(
          { proposalId: editor.proposal.id },
          { conditions, evidence: evidence.trim() },
        );
        onDone(
          answer.proposal.resolution === "already_approved"
            ? "Такая запись уже подтверждена — предложение закрыто без дубля"
            : "Предложение подтверждено с правкой",
        );
      }
    } catch (thrown) {
      if (isConflict(thrown) && editor.kind === "edit") {
        setError({
          text: conflictText(await whoChanged("item_compatibility", editor.record.id)),
          field: null,
        });
      } else {
        setError({ text: catalogErrorText(thrown), field: errorField(thrown) });
      }
    }
  };

  const labels =
    editor?.kind === "edit"
      ? editor.record.label
      : editor?.kind === "approve"
        ? editor.proposal.label
        : undefined;
  return (
    <Dialog
      open={editor !== null}
      onClose={onCancel}
      title={
        editor?.kind === "create"
          ? "Новая запись совместимости"
          : editor?.kind === "edit"
            ? "Изменить запись"
            : "Подтвердить с правкой"
      }
      actions={
        <>
          <Button onClick={submit}>
            {editor?.kind === "approve" ? "Подтвердить" : "Сохранить"}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        <VehicleFields
          value={choice}
          onChange={setChoice}
          mode="conditions"
          labels={labels}
          errorField={error?.field}
          errorText={error?.text}
        />
        <TextField
          label="Основание"
          value={evidence}
          onChange={setEvidence}
          hint="Каталог производителя, ссылка, документ"
          error={error?.field === "evidence" ? error.text : undefined}
        />
        {error &&
          error.field !== "evidence" &&
          ![
            "makeId",
            "modelId",
            "generationId",
            "bodyTypeId",
            "engineId",
            "transmissionTypeId",
            "driveTypeId",
            "yearFrom",
            "yearTo",
          ].includes(error.field ?? "") && <Banner tone="warning">{error.text}</Banner>}
      </div>
    </Dialog>
  );
}

/** «Подходит ли автомобилю» — the server's answer for the chosen car. */
function CompatibilityCheck({ itemId }: { itemId: string }) {
  const [choice, setChoice] = useState<VehicleChoice>(EMPTY_CHOICE);
  const [answer, setAnswer] = useState<AdminCompatibilityCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setError(null);
    setChecking(true);
    try {
      setAnswer(
        await apiClient.checkItemCompatibilityAdmin(
          { itemId },
          { vehicle: choice.makeId ? vehicleOf(choice) : null },
        ),
      );
    } catch (thrown) {
      setAnswer(null);
      setError(catalogErrorText(thrown));
    } finally {
      setChecking(false);
    }
  };

  const result = answer?.result;
  return (
    <section className="card cat-block">
      <div className="section__head">
        <h3 className="section__title">Проверить на автомобиле</h3>
      </div>
      <p className="section__note">
        Ответ считает сервер — тем же расчётом, что каталог приложения.
      </p>
      <VehicleFields value={choice} onChange={setChoice} mode="car" compact />
      <ActionBar
        label="Проверка совместимости"
        others={[
          <Button
            key="check"
            variant="secondary"
            loading={checking}
            onClick={check}
            disabled={!choice.makeId}
          >
            Проверить
          </Button>,
        ]}
        note={!choice.makeId ? "Сначала выберите марку" : undefined}
      />
      {error && <Banner tone="warning">{error}</Banner>}
      {result && (
        <div className={`check-result check-result--${result.result ?? "none"}`} role="status">
          <CompatibilityMark value={markOf(result.result)}>
            {result.result ? COMPATIBILITY_RESULT_TEXT[result.result] : "Совместимость не указана"}
          </CompatibilityMark>
          {result.missing.length > 0 && (
            <span className="ac-text-body-s">
              Уточните: {result.missing.map((level) => COMPATIBILITY_LEVEL_TEXT[level]).join(", ")}
            </span>
          )}
          <span className="ac-text-caption ac-muted">
            {result.listed
              ? "В списке каталога позиция видна"
              : "В списке каталога позиция не видна"}
            {answer?.visibleToClients
              ? ""
              : " · сейчас позиция не видна клиентам (черновик, архив или скрытая категория)"}
          </span>
        </div>
      )}
    </section>
  );
}

/** The compatibility mark of DESIGN 7.8 for the server's result. */
function markOf(result: AdminCompatibilityCheckResponse["result"]["result"]) {
  switch (result) {
    case "fits":
      return "fits" as const;
    case "needs_details":
      return "missingParameter" as const;
    case "does_not_fit":
      return "doesNotFit" as const;
    default:
      return "unknown" as const;
  }
}
