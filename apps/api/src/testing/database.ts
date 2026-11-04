import type { Client } from "pg";

/** Empties every application table between integration tests (children first). */
export const TRUNCATE_ALL =
  "TRUNCATE notification_recipient_state, notification_delivery, notification, device_token, payment_webhook_event, payment_attempt, card_binding, payment_method, billing_event, subscription, plan, supplier_rating_history, supplier_rating, complaint, review, catalog_request, supplier_sku_mapping, price_import_refusal, price_import_format, price_import_row, price_import, search_outbox, item_search_synonym, message_button_press, inbound_webhook_event, outbound_message, admin_signal, user_discipline_event, order_event, customer_order, club_access_grant, offer_model_price, offer, supplier_invitation, supplier_lead_note, supplier_closed_date, supplier_location, supplier_lead, city, item_compatibility_proposal, item_compatibility, vehicle_modification, vehicle_import_row, vehicle_import, vehicle_engine_spelling, vehicle_engine, vehicle_generation, vehicle_model_spelling, vehicle_model, vehicle_make_spelling, vehicle_make, vehicle_option, item_photo_file, item_photo, item_analog, item_attribute_value, catalog_item, brand_spelling, brand, translation, translation_task, ai_job, attribute_option, attribute, category, audit_log, periodic_job_state, app_setting_change, app_setting, sign_in_step, admin_backup_code, admin_user, session, supplier_member, supplier, otp_challenge, review_login, phone_verification, account_car, account";

/** How long one emptying waits for a lock before it gives way and tries again. */
const LOCK_TIMEOUT = "3s";
const ATTEMPTS = 20;
const PAUSE_MS = 200;

/** Lost a deadlock (`40P01`) or waited out `lock_timeout` (`55P03`): worth another try. */
function isLockConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40P01" || code === "55P03";
}

/**
 * Empties every application table between integration tests (TASK-042.B).
 *
 * The worker of a suite is live: its jobs and sweepers work on the same
 * tables, a dozen of them at the top of every minute. A `TRUNCATE` that stood
 * in the queue of locks would hold everything behind it, and one that meets a
 * job's lock the other way round loses a deadlock. So the emptying waits at
 * most `lock_timeout` and is tried again; a lock still there after every try
 * is a transaction somebody left open — the error names it (with its last
 * statement) instead of the hook hanging until its timeout.
 *
 * `alsoRun` — statements of the suite that belong to the same emptying (the
 * queue's jobs of the previous test, for example): in the same transaction.
 */
export async function truncateAll(db: Client, alsoRun: readonly string[] = []): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query("BEGIN");
      await db.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await db.query(TRUNCATE_ALL);
      for (const statement of alsoRun) await db.query(statement);
      await db.query("COMMIT");
      return;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      if (!isLockConflict(error)) throw error;
      if (attempt >= ATTEMPTS) {
        throw new Error(
          `The tables could not be emptied after ${String(ATTEMPTS)} tries (${(error as Error).message}); open transactions: ${JSON.stringify(await openTransactions(db))}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  }
}

/** Who else is in a transaction now, and what it ran last. */
async function openTransactions(db: Client): Promise<unknown[]> {
  try {
    const { rows } = await db.query(
      `SELECT pid, application_name, state, wait_event_type, wait_event, now() - xact_start AS in_transaction,
              pg_blocking_pids(pid) AS blocked_by, left(query, 200) AS query
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
       ORDER BY xact_start`,
    );
    return rows;
  } catch {
    return [];
  }
}
