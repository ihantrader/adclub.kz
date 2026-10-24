import type { AuditLogEntry } from "@adclub/contracts";
import { Button } from "@adclub/ui";
import { useState } from "react";
import { CLUB_TIME_ZONE, formatMoment } from "../format";
import { AppLink, Table } from "../layout/layout";
import {
  actionText,
  actorLines,
  changeLines,
  entityLink,
  entityText,
  groupJournal,
  objectsText,
  hiddenFieldsOf,
  reasonText,
  visibleChangeText,
  type ChangeLine,
} from "./audit-words";
import { useSettingTitles } from "./use-setting-titles";

/** «было → стало» lines shown before «Подробнее». */
const SHORT_LINES = 2;

const COLUMNS = [
  { key: "at", header: "Время", width: 136 },
  { key: "who", header: "Кто", width: 176 },
  { key: "what", header: "Действие" },
  { key: "change", header: "Было → стало", width: 300 },
  { key: "reason", header: "Причина", width: 200 },
];

/**
 * The rows of the journal (A-AUD and every card's «История»; TASK-080, X16):
 * fixed columns — the time in one line, who by name, the action and its
 * object in words, «было → стало» without backgrounds (the old value
 * `textMuted`, the new one `text`), the reason; ids, service marks and
 * codes only under «Подробнее». Alike entries in a row are one row with
 * «· N раз». A card's own history (`selfId`) does not link to itself.
 */
export function JournalTable({
  entries,
  caption,
  selfId,
}: {
  entries: readonly AuditLogEntry[];
  caption: string;
  /** The object whose history this is: its rows don't name and link it again. */
  selfId?: string;
}) {
  const groups = groupJournal(entries, visibleChangeText);
  const settingTitles = useSettingTitles(entries.some((entry) => entry.entityType === "setting"));
  return (
    <Table
      label={`${caption}, время — Алматы (${CLUB_TIME_ZONE})`}
      columns={COLUMNS}
      className="journal-table"
    >
      {groups.map((group) => (
        <JournalRow
          key={group.entry.id}
          entry={group.entry}
          count={group.count}
          firstAt={group.firstAt}
          objects={group.objects}
          selfId={selfId}
          settingTitles={settingTitles}
        />
      ))}
    </Table>
  );
}

function ChangeText({ line }: { line: ChangeLine }) {
  return (
    <span className="change-line">
      {line.field && <span className="change-line__field">{line.field}: </span>}
      {line.text !== undefined ? (
        <span className="change-line__new">{line.text}</span>
      ) : (
        <>
          <span className="change-line__old">{line.before}</span>
          <span className="change-line__arrow" aria-label="стало">
            {" → "}
          </span>
          <span className="change-line__new">{line.after}</span>
        </>
      )}
    </span>
  );
}

function JournalRow({
  entry,
  count,
  firstAt,
  objects,
  selfId,
  settingTitles,
}: {
  entry: AuditLogEntry;
  count: number;
  firstAt: string;
  /** The objects of a repeated event over several of them; empty — one object. */
  objects: readonly string[];
  selfId?: string;
  settingTitles: ReadonlyMap<string, string>;
}) {
  // A setting by what it does, not by its key (X16).
  const objectName =
    entry.entityType === "setting"
      ? (settingTitles.get(entry.entityId) ?? entry.entityName)
      : entry.entityName;
  const [open, setOpen] = useState(false);
  const all = changeLines(entry.before, entry.after, hiddenFieldsOf(entry.entityType), {
    entityType: entry.entityType,
    names: entry.names,
  });
  // A group over several objects: each object's own lines differ — under «Подробнее» only.
  const many = objects.length > 0;
  const visible = many ? [] : all.filter((line) => !line.technical);
  const technical = many ? all : all.filter((line) => line.technical);
  const shown = open ? visible : visible.slice(0, SHORT_LINES);
  const more = visible.length - shown.length + (open ? 0 : technical.length) + 1;
  const link = entityLink(entry.entityType, entry.entityId, entry);
  const self = selfId !== undefined && entry.entityId === selfId;
  const who = actorLines(entry.actor);
  return (
    <tr>
      <td className="nowrap ac-text-body-s">
        <span className="cell-stack">
          <span>{formatMoment(entry.at)}</span>
          {count > 1 && <span className="row-title__sub">с {formatMoment(firstAt)}</span>}
        </span>
      </td>
      <td>
        <span className="cell-stack">
          <span className="ac-text-body-s cell-one-line" title={who.name}>
            {who.name}
          </span>
          {who.note && <span className="row-title__sub">{who.note}</span>}
        </span>
      </td>
      <td>
        <span className="cell-stack">
          <span className="ac-text-body-strong">
            {actionText(entry.action)}
            {count > 1 && <span className="ac-muted"> · {count} раз</span>}
          </span>
          {many && (
            <span className="row-title__sub">
              {entityText(entry.entityType)}: {objectsText(objects)}
            </span>
          )}
          {!self && !many && (
            <span className="row-title__sub">
              {entityText(entry.entityType)}
              {": "}
              {link ? (
                <AppLink href={link}>{objectName ?? "открыть"}</AppLink>
              ) : (
                <span>{objectName ?? "не найден"}</span>
              )}
            </span>
          )}
        </span>
      </td>
      <td>
        <span className="cell-stack change-lines">
          {shown.length === 0 && !open && <span className="ac-muted">—</span>}
          {shown.map((line, index) => (
            <ChangeText key={index} line={line} />
          ))}
          {open && (
            <span className="change-lines__details">
              {technical.map((line, index) => (
                <ChangeText key={index} line={line} />
              ))}
              <span className="change-line">
                <span className="change-line__field">Идентификатор: </span>
                <span className="change-line__old">{entry.entityId}</span>
              </span>
            </span>
          )}
          <Button variant="text" size="s" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Свернуть" : more > 1 ? `Подробнее (${String(more - 1)})` : "Подробнее"}
          </Button>
        </span>
      </td>
      <td className="ac-text-body-s">
        {entry.reason ? (
          reasonText(entry.action, entry.reason)
        ) : (
          <span className="ac-muted">—</span>
        )}
      </td>
    </tr>
  );
}
