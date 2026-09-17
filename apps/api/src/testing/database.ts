/** Empties every application table between integration tests (children first). */
export const TRUNCATE_ALL =
  "TRUNCATE sign_in_step, admin_backup_code, admin_user, session, supplier_member, supplier, otp_challenge, phone_verification, account";
