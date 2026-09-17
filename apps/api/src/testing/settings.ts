import type { INestApplicationContext } from "@nestjs/common";
import { AppSettings, SettingsChangeService, type SettingValues } from "../modules/settings";

/**
 * Integration tests set thresholds the way the product does (TASK-007):
 * a change through `SettingsChangeService` — the path of the operator
 * command, with its checks and history — applied to this process at once.
 */
export class TestSettings {
  constructor(private readonly app: INestApplicationContext) {}

  async set(values: Partial<SettingValues>): Promise<void> {
    const changes = this.app.get(SettingsChangeService);
    for (const [key, value] of Object.entries(values)) {
      await changes.change({
        key,
        value,
        expectedVersion: undefined,
        reason: "integration test",
        actor: { kind: "operator" },
      });
    }
  }

  /** Re-reads the stored values (after the tables were emptied). */
  async reload(): Promise<void> {
    await this.app.get(AppSettings).refresh();
  }

  async values(): Promise<Readonly<SettingValues>> {
    return this.app.get(AppSettings).values();
  }
}
