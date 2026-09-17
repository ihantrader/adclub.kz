import type { AuditEntryInput } from "../audit";
import type { DbExecutor } from "../../database";

/**
 * Where this module records the actions people take (`audit_log`,
 * ARCHITECTURE 4.13). Declared here and provided by the audit module, so
 * identity never imports it back — the same shape as the settings sources
 * of TASK-007. An entry is written in the transaction of the action, so a
 * rollback takes the entry with it.
 */
export abstract class ActionJournal {
  abstract record(entry: AuditEntryInput, executor: DbExecutor): Promise<string>;
}
