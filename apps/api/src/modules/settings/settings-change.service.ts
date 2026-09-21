import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { auditActions, auditEntities } from "@adclub/contracts";
import type {
  Setting,
  SettingActor,
  SettingChange,
  SettingChangedResponse,
  SettingHistoryResponse,
  SettingListResponse,
  SettingVersionConflictDetails,
} from "@adclub/contracts";
import { sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import { AccountDirectory } from "../identity";
import { AppSettings, checkStoredSetting } from "./app-settings";
import {
  isSettingKey,
  settingDefinition,
  settingGroups,
  type SettingKey,
} from "./registry/registry";
import {
  checkSettingValue,
  describeConstraints,
  unitOf,
  type SettingDefinition,
} from "./registry/setting-definition";
import {
  SettingsStore,
  type SettingActorRecord,
  type SettingChangeRecord,
  type StoredSetting,
} from "./settings.store";

export type SettingChangeActor = SettingActorRecord;

export interface ChangeSettingInput {
  key: string;
  value: unknown;
  /** The version the change was made from; `undefined` — whatever is current (operator only). */
  expectedVersion: number | undefined;
  reason: string;
  actor: SettingChangeActor;
}

export interface ResetSettingInput {
  key: string;
  expectedVersion: number | undefined;
  reason: string;
  actor: SettingChangeActor;
}

/** Longest value text written to the application log (texts can be long). */
const LOGGED_VALUE_LENGTH = 200;

function logged(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > LOGGED_VALUE_LENGTH ? `${text.slice(0, LOGGED_VALUE_LENGTH)}…` : text;
}

function notFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such setting");
}

function validationError(issues: { path: string; message: string }[]): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", "The value doesn't fit the setting", {
    details: issues,
  });
}

/** The same actor, as the action journal records it (ARCHITECTURE 4.13). */
function auditActorOf(actor: SettingChangeActor): AuditActorRecord {
  return actor.kind === "admin"
    ? { role: "admin", accountId: actor.accountId, adminId: actor.adminId }
    : { role: "operator" };
}

const reasonSchema = z.string().trim().min(3).max(500);

/** The contract checks the reason of an API request; the operator command's is checked here. */
function reasonOf(input: string): string {
  const result = reasonSchema.safeParse(input);
  if (!result.success) {
    throw validationError(
      result.error.issues.map((issue) => ({ path: "reason", message: issue.message })),
    );
  }
  return result.data;
}

/** A value read from JSON (never `undefined`). */
type JsonValue = SettingChange["newValue"];

interface KeyState {
  definition: SettingDefinition;
  stored: StoredSetting | undefined;
  /** The value in effect: the stored one if it passes its check, else the default. */
  effective: unknown;
  isDefault: boolean;
  storedValueInvalid: boolean;
}

/**
 * Reading and changing settings (ARCHITECTURE 4.11): the list, a change
 * and a reset with a reason and the version they were made from, the
 * history. Used by the admin API and by the operator command; the
 * sign-in security settings (D-053) refuse an administrator.
 */
@Injectable()
export class SettingsChangeService {
  private readonly logger = new Logger("Settings");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SettingsStore) private readonly store: SettingsStore,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AccountDirectory) private readonly accounts: AccountDirectory,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async list(): Promise<SettingListResponse> {
    const [stored, latest] = await Promise.all([
      this.store.listStored(),
      this.store.latestChanges(),
    ]);
    const storedByKey = new Map(stored.map((row) => [row.key, row]));
    const latestByKey = new Map(latest.map((row) => [row.key, row]));
    const phones = await this.phonesOf(latest);
    return {
      groups: settingGroups.map((group) => ({
        id: group.id,
        title: group.title,
        settings: (Object.keys(group.settings) as SettingKey[]).map((key) =>
          this.describe(key, this.stateOf(key, storedByKey.get(key)), latestByKey.get(key), phones),
        ),
      })),
    };
  }

  async get(key: string): Promise<Setting> {
    const definitionKey = this.keyOf(key);
    const [stored, history] = await Promise.all([
      this.store.findStored(definitionKey, this.database.db),
      this.store.history(definitionKey),
    ]);
    const latest = history[0];
    return this.describe(
      definitionKey,
      this.stateOf(definitionKey, stored),
      latest,
      await this.phonesOf(latest ? [latest] : []),
    );
  }

  async history(key: string): Promise<SettingHistoryResponse> {
    const definitionKey = this.keyOf(key);
    const changes = await this.store.history(definitionKey);
    const phones = await this.phonesOf(changes);
    return { key: definitionKey, changes: changes.map((change) => this.toChange(change, phones)) };
  }

  async change(input: ChangeSettingInput): Promise<SettingChangedResponse> {
    const key = this.keyOf(input.key);
    const definition = settingDefinition(key);
    this.assertMayChange(key, definition, input.actor);
    const reason = reasonOf(input.reason);
    const checked = checkSettingValue(definition, input.value, this.settings.checkContext);
    if (!checked.ok) {
      this.logger.log(
        `Setting change refused key=${key} by=${this.actorLabel(input.actor)} reason=invalid_value issues=${checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );
      throw validationError(checked.issues);
    }
    await this.assertReferenceExists(key, definition, checked.value, input.actor);
    return this.apply(key, input.expectedVersion, input.actor, "set", reason, checked.value);
  }

  /**
   * A value that names a record of a directory must name one that exists
   * and is active (`default_city` — a city by code, or by a name for
   * values of before the directory; TASK-016).
   */
  private async assertReferenceExists(
    key: SettingKey,
    definition: SettingDefinition,
    value: unknown,
    actor: SettingChangeActor,
  ): Promise<void> {
    if (definition.type !== "string" || definition.reference !== "city") {
      return;
    }
    const text = String(value);
    const found = await this.database.db.execute(sql`
      SELECT 1 FROM city
      WHERE status = 'active'
        AND (code = ${text} OR lower(${text}) IN (lower(name_ru), lower(name_kk), lower(name_en)))
    `);
    if (found.rows.length === 0) {
      this.logger.log(
        `Setting change refused key=${key} by=${this.actorLabel(actor)} reason=unknown_city`,
      );
      throw validationError([
        { path: "value", message: "No active city of the directory has this code or name" },
      ]);
    }
  }

  async reset(input: ResetSettingInput): Promise<SettingChangedResponse> {
    const key = this.keyOf(input.key);
    this.assertMayChange(key, settingDefinition(key), input.actor);
    const reason = reasonOf(input.reason);
    return this.apply(key, input.expectedVersion, input.actor, "reset", reason, undefined);
  }

  private async apply(
    key: SettingKey,
    expectedVersion: number | undefined,
    actor: SettingChangeActor,
    action: "set" | "reset",
    reason: string,
    value: unknown,
  ): Promise<SettingChangedResponse> {
    const result = await this.database.db.transaction(async (tx) => {
      await this.store.lockKey(key, tx);
      const currentVersion = await this.store.currentVersion(key, tx);
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        return { kind: "conflict", currentVersion } as const;
      }
      const before = this.stateOf(key, await this.store.findStored(key, tx));
      const version = currentVersion + 1;
      if (action === "set") {
        await this.store.write(key, value, version, actor, tx);
      } else {
        await this.store.remove(key, tx);
      }
      const newValue = action === "set" ? value : before.definition.default;
      const change = await this.store.appendChange(
        {
          key,
          version,
          action,
          previousValue: before.effective,
          previousIsDefault: before.isDefault,
          newValue,
          newIsDefault: action === "reset",
          reason,
          actor,
        },
        tx,
      );
      // In the same transaction as the change itself: no change without an
      // entry in the action journal and no entry without a change
      // (ARCHITECTURE 4.13). The history `app_setting_change` stays as it
      // is — it carries the version a change was made from, which is what
      // the admin panel edits against.
      await this.audit.record(
        {
          action: action === "set" ? auditActions.settingChanged : auditActions.settingReset,
          actor: auditActorOf(actor),
          entityType: auditEntities.setting,
          entityId: key,
          before: { value: change.previousValue, isDefault: change.previousIsDefault },
          after: { value: change.newValue, isDefault: change.newIsDefault, version },
          reason,
        },
        tx,
      );
      const after = this.stateOf(key, await this.store.findStored(key, tx));
      return { kind: "applied", change, after } as const;
    });

    if (result.kind === "conflict") {
      this.logger.log(
        `Setting change refused key=${key} by=${this.actorLabel(actor)} reason=version_conflict expectedVersion=${expectedVersion} currentVersion=${result.currentVersion}`,
      );
      const details: SettingVersionConflictDetails = { currentVersion: result.currentVersion };
      throw new ApiException(
        409,
        "SETTING_VERSION_CONFLICT",
        "The setting was changed by someone else; reload it and decide again",
        { details },
      );
    }

    const { change } = result;
    this.logger.log(
      `Setting ${action === "set" ? "changed" : "reset"} key=${key} version=${change.version} by=${this.actorLabel(actor)} from=${logged(change.previousValue)} to=${logged(change.newValue)}`,
    );
    // This process applies the change at once; the others within the
    // cache lifetime.
    try {
      await this.settings.refresh();
    } catch {
      // Logged by AppSettings; the change is committed either way.
    }
    const phones = await this.phonesOf([change]);
    return {
      setting: this.describe(key, result.after, change, phones),
      change: this.toChange(change, phones),
    };
  }

  private keyOf(key: string): SettingKey {
    if (!isSettingKey(key)) {
      throw notFound();
    }
    return key;
  }

  private assertMayChange(
    key: SettingKey,
    definition: SettingDefinition,
    actor: SettingChangeActor,
  ): void {
    if (actor.kind === "admin" && definition.editableBy === "operator") {
      this.logger.log(
        `Setting change refused key=${key} by=${this.actorLabel(actor)} reason=operator_only`,
      );
      throw new ApiException(
        403,
        "SETTING_OPERATOR_ONLY",
        "This sign-in security setting is changed by the server operator command only",
      );
    }
  }

  private stateOf(key: SettingKey, stored: StoredSetting | undefined): KeyState {
    const definition = settingDefinition(key);
    const checked = stored ? checkStoredSetting(stored, this.settings.checkContext) : undefined;
    const valid = checked?.state === "valid";
    return {
      definition,
      stored,
      effective: valid ? checked.value : definition.default,
      isDefault: !valid,
      storedValueInvalid: checked?.state === "invalid",
    };
  }

  private describe(
    key: SettingKey,
    state: KeyState,
    latest: SettingChangeRecord | undefined,
    phones: Map<string, string>,
  ): Setting {
    const { definition } = state;
    return {
      key,
      group: definition.group,
      type: definition.type,
      unit: unitOf(definition),
      description: definition.description,
      constraints: describeConstraints(definition, this.settings.checkContext),
      defaultValue: definition.default as JsonValue,
      value: state.effective as JsonValue,
      isDefault: state.isDefault,
      storedValueInvalid: state.storedValueInvalid,
      version: latest?.version ?? 0,
      editableBy: definition.editableBy,
      lastChange: latest
        ? {
            action: latest.action,
            by: this.actorOf(latest, phones),
            at: latest.createdAt.toISOString(),
          }
        : null,
    };
  }

  private toChange(record: SettingChangeRecord, phones: Map<string, string>): SettingChange {
    return {
      id: record.id,
      key: record.key,
      version: record.version,
      action: record.action,
      previousValue: record.previousValue as JsonValue,
      previousIsDefault: record.previousIsDefault,
      newValue: record.newValue as JsonValue,
      newIsDefault: record.newIsDefault,
      reason: record.reason,
      by: this.actorOf(record, phones),
      at: record.createdAt.toISOString(),
    };
  }

  private actorOf(record: SettingChangeRecord, phones: Map<string, string>): SettingActor {
    if (record.actorKind === "admin" && record.actorAdminId) {
      return {
        kind: "admin",
        adminId: record.actorAdminId,
        phoneMasked: (record.actorAccountId && phones.get(record.actorAccountId)) ?? null,
      };
    }
    return { kind: "operator" };
  }

  private phonesOf(records: readonly SettingChangeRecord[]): Promise<Map<string, string>> {
    return this.accounts.maskedPhones(
      records.flatMap((record) => (record.actorAccountId ? [record.actorAccountId] : [])),
    );
  }

  private actorLabel(actor: SettingChangeActor): string {
    return actor.kind === "admin" ? `admin:${actor.adminId}` : "operator";
  }
}
