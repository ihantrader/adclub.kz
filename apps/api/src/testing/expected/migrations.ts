/**
 * Every migration of `infra/migrations`, by name, in the order they are
 * applied. The database test checks it against `pgmigrations` after `up`;
 * `expected-lists.test.ts` checks it against the files without containers.
 * A new migration is added here.
 */
export const EXPECTED_MIGRATIONS: readonly string[] = [
  "1789583044021_create-account",
  "1789620211794_create-login-code",
  "1789627880146_create-session",
  "1789639354506_create-roles",
  "1789644232969_bind-sign-in-step-to-client",
  "1789656263507_create-app-setting",
  "1789660668561_create-job-queue",
  "1789660680048_create-periodic-job-state",
  "1789660681238_add-sign-in-data-cleanup-indexes",
  "1789677720444_create-audit-log",
  "1789740000000_create-catalog-structure",
  "1789830000000_create-catalog-items",
  "1789900000000_create-ai-jobs-and-translation-tasks",
  "1789990000000_ai-through-openrouter",
  "1790050000000_create-item-photos",
  "1790100000000_create-vehicles",
  "1790150000000_create-item-compatibility",
  "1790200000000_create-suppliers",
  "1790250000000_supplier-members",
  "1790300000000_create-offers",
  "1790350000000_create-club-access",
  "1790400000000_create-orders",
  "1790450000000_close-orders",
  "1790500000000_create-messaging",
  "1790550000000_order-notices",
  "1790600000000_account-profile-and-garage",
  "1790650000000_account-car-idempotency-key",
  "1790700000000_supplier-delivery-by-default",
  "1790750000000_button-press-supplier-blocked",
  "1790800000000_admin-signal-actions",
  "1790850000000_admin-cancel-order",
  "1790900000000_account-car-document",
  "1790950000000_on-order-orders",
];
