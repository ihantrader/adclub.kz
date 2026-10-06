-- Up Migration
-- A press of a button of W-01 by an employee of a blocked company
-- (TASK-033.A, ARCHITECTURE 4.51; SCREENS 6.0): the move is not allowed, the
-- order doesn't change and the press keeps the outcome `supplier_blocked`.

ALTER TABLE message_button_press DROP CONSTRAINT message_button_press_outcome_check;
ALTER TABLE message_button_press
  ADD CONSTRAINT message_button_press_outcome_check CHECK (
    outcome IS NULL OR outcome IN (
      'accepted', 'declined', 'repeated', 'conflict', 'member_removed', 'supplier_blocked',
      'invalid_payload', 'expired', 'phone_mismatch', 'foreign_message', 'no_handler'
    )
  );

-- Down Migration
-- The previous list has no such outcome: a refused press becomes the nearest
-- one it had — nothing changed on the order (`conflict`).
UPDATE message_button_press SET outcome = 'conflict' WHERE outcome = 'supplier_blocked';
ALTER TABLE message_button_press DROP CONSTRAINT message_button_press_outcome_check;
ALTER TABLE message_button_press
  ADD CONSTRAINT message_button_press_outcome_check CHECK (
    outcome IS NULL OR outcome IN (
      'accepted', 'declined', 'repeated', 'conflict', 'member_removed',
      'invalid_payload', 'expired', 'phone_mismatch', 'foreign_message', 'no_handler'
    )
  );
