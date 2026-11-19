-- Up Migration
-- Deleting a car of the garage — and so deleting the account — clears the
-- links to it (`ON DELETE SET NULL`) in the orders and in the dialogs of the
-- assistant. Without an index each deleted car scanned both tables in one
-- statement, under the 2 s limit, and the tables only grow (acceptance of
-- TASK-072.A; ARCHITECTURE 4.96). Few rows name a car, so the indexes are
-- partial.

CREATE INDEX customer_order_car_idx ON customer_order (car_id) WHERE car_id IS NOT NULL;
CREATE INDEX assistant_dialog_car_idx ON assistant_dialog (car_id) WHERE car_id IS NOT NULL;

-- Down Migration
DROP INDEX assistant_dialog_car_idx;
DROP INDEX customer_order_car_idx;
