import { describe, expect, it } from "vitest";
import { canEnableNotifications, notificationRecipients } from "./supplier-members";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));

describe("the recipients of order notifications", () => {
  it("are the employees with the switch on, up to the limit", () => {
    const result = notificationRecipients(
      [
        { id: "a", notificationsEnabledAt: at(1), createdAt: at(0) },
        { id: "b", notificationsEnabledAt: null, createdAt: at(0) },
        { id: "c", notificationsEnabledAt: at(2), createdAt: at(0) },
      ],
      5,
    );
    expect([...result.recipients].sort()).toEqual(["a", "c"]);
    expect(result).toMatchObject({ limit: 5, enabled: 2, full: false });
  });

  it("keeps the earliest to turn it on when the limit is lowered; no switch is turned off", () => {
    const candidates = [
      { id: "late", notificationsEnabledAt: at(9), createdAt: at(0) },
      { id: "first", notificationsEnabledAt: at(1), createdAt: at(5) },
      { id: "second", notificationsEnabledAt: at(3), createdAt: at(1) },
      { id: "tie-b", notificationsEnabledAt: at(5), createdAt: at(2) },
      { id: "tie-a", notificationsEnabledAt: at(5), createdAt: at(2) },
    ];
    const lowered = notificationRecipients(candidates, 3);
    expect([...lowered.recipients].sort()).toEqual(["first", "second", "tie-a"]);
    expect(lowered).toMatchObject({ enabled: 5, full: true });
    expect([...notificationRecipients(candidates, 1).recipients]).toEqual(["first"]);
    expect(notificationRecipients(candidates, 10).recipients.size).toBe(5);
  });

  it("lets one more turn it on only below the limit", () => {
    expect(canEnableNotifications(4, 5)).toBe(true);
    expect(canEnableNotifications(5, 5)).toBe(false);
    expect(canEnableNotifications(7, 5)).toBe(false);
  });
});
