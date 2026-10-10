/**
 * The background jobs of the application, in the order of
 * `backgroundJobCatalog` (development and tests included), and the schedule
 * the worker registers for each periodic one with the default settings.
 * The cleanup test checks them against a real queue; `expected-lists.test.ts`
 * checks them against the catalog without containers. A new job is added here.
 */
export const EXPECTED_JOB_NAMES: readonly string[] = [
  "identity.cleanup-login-codes",
  "identity.cleanup-sign-in-steps",
  "identity.cleanup-sessions",
  "catalog.translate",
  "catalog.translation-wake",
  "catalog.delete-photo-files",
  "catalog.cleanup-photo-files",
  "vehicles.analyze-import",
  "vehicles.apply-import",
  "vehicles.expire-imports",
  "messaging.send",
  "messaging.apply-webhook-event",
  "messaging.apply-button-press",
  "messaging.cleanup-webhook-events",
  "messaging.clear-stale-variables",
  "messaging.recover-interrupted",
  "suppliers.send-invitation",
  "orders.apply-deadlines",
  "orders.cleanup-idempotency-keys",
  "orders.watch-notice-channel",
  "orders.watch-supplier-reach",
  "dev.always-fails",
  "dev.daily-at-setting",
];

export const EXPECTED_PERIODIC_SCHEDULES: readonly {
  name: string;
  cron: string;
  timezone: string;
}[] = [
  // Files of photos no record points at (TASK-013): hourly.
  { name: "catalog.cleanup-photo-files", cron: "17 * * * *", timezone: "Asia/Almaty" },
  // Files of removed photos, once their retention has passed (TASK-013).
  { name: "catalog.delete-photo-files", cron: "* * * * *", timezone: "Asia/Almaty" },
  // Safety net of automatic translation (TASK-012): every five minutes.
  { name: "catalog.translation-wake", cron: "*/5 * * * *", timezone: "Asia/Almaty" },
  // Development and tests only: daily at `billing_notify_hour` (10 by default).
  { name: "dev.daily-at-setting", cron: "0 10 * * *", timezone: "Asia/Almaty" },
  { name: "identity.cleanup-login-codes", cron: "* * * * *", timezone: "Asia/Almaty" },
  { name: "identity.cleanup-sessions", cron: "* * * * *", timezone: "Asia/Almaty" },
  { name: "identity.cleanup-sign-in-steps", cron: "* * * * *", timezone: "Asia/Almaty" },
  // Webhook deliveries of the message provider once applied and old (TASK-024).
  { name: "messaging.cleanup-webhook-events", cron: "* * * * *", timezone: "Asia/Almaty" },
  // The values of settled messages once their retention has passed (TASK-024).
  { name: "messaging.clear-stale-variables", cron: "* * * * *", timezone: "Asia/Almaty" },
  // Messages whose sending was interrupted and whose job will not come back (TASK-024).
  { name: "messaging.recover-interrupted", cron: "* * * * *", timezone: "Asia/Almaty" },
  // Deadlines of orders: no answer, the end of a reserve, its warning (TASK-021).
  { name: "orders.apply-deadlines", cron: "* * * * *", timezone: "Asia/Almaty" },
  // Keys of creation requests of orders long finished (TASK-022).
  { name: "orders.cleanup-idempotency-keys", cron: "* * * * *", timezone: "Asia/Almaty" },
  // The detector of an outage of the channel of order notices (TASK-025).
  { name: "orders.watch-notice-channel", cron: "* * * * *", timezone: "Asia/Almaty" },
  // The detector of a supplier no notice can reach (TASK-034, D-061).
  { name: "orders.watch-supplier-reach", cron: "* * * * *", timezone: "Asia/Almaty" },
  // Imports of the vehicle catalog stuck longer than allowed (TASK-014).
  { name: "vehicles.expire-imports", cron: "* * * * *", timezone: "Asia/Almaty" },
];
