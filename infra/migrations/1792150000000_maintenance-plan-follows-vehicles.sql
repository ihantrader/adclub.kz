-- Up Migration
-- A maintenance plan follows the vehicle catalog (TASK-061.A; ARCHITECTURE
-- 4.84 I946): a model moved to another make, a generation to another model
-- (4.24 I221) keeps meaning the same cars, so the plans naming it move with
-- it — as compatibility records do (`item_compatibility_follow_*`).
--
-- The composite keys that hold the levels together are checked at the end
-- of the transaction: the vehicle row changes first, the plans follow in
-- the trigger, and only the result has to agree. Without that the key on
-- the plan's side refused the move (a 500 in «Автомобили»). The trigger
-- moves the version of each plan it changes; the maintenance module writes
-- the journal entry of each in the same transaction (`VehicleMoves`).

ALTER TABLE maintenance_plan DROP CONSTRAINT maintenance_plan_model_fkey;
ALTER TABLE maintenance_plan DROP CONSTRAINT maintenance_plan_generation_fkey;
ALTER TABLE maintenance_plan ADD CONSTRAINT maintenance_plan_model_fkey
  FOREIGN KEY (model_id, make_id) REFERENCES vehicle_model (id, make_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE maintenance_plan ADD CONSTRAINT maintenance_plan_generation_fkey
  FOREIGN KEY (generation_id, model_id) REFERENCES vehicle_generation (id, model_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION maintenance_plan_follow_model() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE maintenance_plan
    SET make_id = NEW.make_id, version = version + 1, updated_at = now()
    WHERE model_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER maintenance_plan_follow_model
  AFTER UPDATE OF make_id ON vehicle_model
  FOR EACH ROW WHEN (OLD.make_id IS DISTINCT FROM NEW.make_id)
  EXECUTE FUNCTION maintenance_plan_follow_model();

CREATE FUNCTION maintenance_plan_follow_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_make UUID;
BEGIN
  SELECT make_id INTO new_make FROM vehicle_model WHERE id = NEW.model_id;
  UPDATE maintenance_plan
    SET model_id = NEW.model_id, make_id = new_make, version = version + 1, updated_at = now()
    WHERE generation_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER maintenance_plan_follow_generation
  AFTER UPDATE OF model_id ON vehicle_generation
  FOR EACH ROW WHEN (OLD.model_id IS DISTINCT FROM NEW.model_id)
  EXECUTE FUNCTION maintenance_plan_follow_generation();

-- Down Migration
DROP TRIGGER maintenance_plan_follow_generation ON vehicle_generation;
DROP FUNCTION maintenance_plan_follow_generation();
DROP TRIGGER maintenance_plan_follow_model ON vehicle_model;
DROP FUNCTION maintenance_plan_follow_model();
ALTER TABLE maintenance_plan DROP CONSTRAINT maintenance_plan_generation_fkey;
ALTER TABLE maintenance_plan DROP CONSTRAINT maintenance_plan_model_fkey;
ALTER TABLE maintenance_plan ADD CONSTRAINT maintenance_plan_model_fkey
  FOREIGN KEY (model_id, make_id) REFERENCES vehicle_model (id, make_id);
ALTER TABLE maintenance_plan ADD CONSTRAINT maintenance_plan_generation_fkey
  FOREIGN KEY (generation_id, model_id) REFERENCES vehicle_generation (id, model_id);
