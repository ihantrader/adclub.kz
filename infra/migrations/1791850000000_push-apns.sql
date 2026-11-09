-- Up Migration
-- Push to iPhones straight to APNs (TASK-056; ARCHITECTURE 4.81, I866): a
-- delivery to an iOS device is taken by `apns`, one to Android by `fcm`, with
-- `PUSH_PROVIDER=live`. Only the list of who may have taken a delivery grows.

ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_provider_check;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_provider_check CHECK (
  provider IS NULL OR provider IN ('test', 'fcm', 'apns')
);

-- Down Migration
-- A delivery APNs took keeps its outcome; only who took it is forgotten.
UPDATE notification_delivery SET provider = NULL WHERE provider = 'apns';
ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_provider_check;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_provider_check CHECK (
  provider IS NULL OR provider IN ('test', 'fcm')
);
