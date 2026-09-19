/** Empties every application table between integration tests (children first). */
export const TRUNCATE_ALL =
  "TRUNCATE item_analog, item_attribute_value, catalog_item, brand_spelling, brand, translation, attribute_option, attribute, category, audit_log, periodic_job_state, app_setting_change, app_setting, sign_in_step, admin_backup_code, admin_user, session, supplier_member, supplier, otp_challenge, phone_verification, account";
