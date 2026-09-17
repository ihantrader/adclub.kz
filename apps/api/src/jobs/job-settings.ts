import type { SettingKey, SettingValue } from "../modules/settings";

/**
 * Settings as the job runner reads them (schedules). Provided by the
 * global settings module (`AppSettings`), so this directory depends on it
 * only by type — modules that declare jobs are imported by the settings
 * module themselves.
 */
export abstract class JobSettingsReader {
  abstract get<Key extends SettingKey>(key: Key): Promise<SettingValue<Key>>;
}
