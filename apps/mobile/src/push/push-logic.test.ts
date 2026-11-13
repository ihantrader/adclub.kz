import { describe, expect, it } from "vitest";
import { withPushPromise } from "../orders/order-status";
import {
  offeredOnce,
  parsePushOffers,
  pushMessageOf,
  pushPromised,
  shouldOfferPush,
  PUSH_OFFER_LIMIT,
} from "./push-logic";
import { createStubPushPort } from "./stub-push-port";

const ORDER = "1d2c3b4a-5e6f-4a1b-8c9d-0e1f2a3b4c5d";
const NOTIFICATION = "8d3f0a4c-7b1e-4d2a-9f3c-1e2d3c4b5a69";

describe("what a push carries (TASK-051)", () => {
  it("reads the data the server sends: the id and the target as JSON", () => {
    expect(
      pushMessageOf({
        notificationId: NOTIFICATION,
        target: JSON.stringify({ screen: "order", params: { orderId: ORDER } }),
      }),
    ).toEqual({
      notificationId: NOTIFICATION,
      target: { screen: "order", params: { orderId: ORDER } },
    });
    expect(pushMessageOf({ target: { screen: "subscription" } }).target).toEqual({
      screen: "subscription",
    });
    // P-REM-01/02 (TASK-069): the catalog's home with this car in its header.
    expect(
      pushMessageOf({ target: JSON.stringify({ screen: "catalog", params: { carId: ORDER } }) })
        .target,
    ).toEqual({ screen: "catalog", params: { carId: ORDER } });
    expect(
      pushMessageOf({ target: { screen: "catalog", params: { carId: "1" } } }).target,
    ).toBeNull();
  });

  it("opens nothing for what it does not understand", () => {
    expect(pushMessageOf(null)).toEqual({ notificationId: null, target: null });
    expect(pushMessageOf({ notificationId: "x", target: "{bad" })).toEqual({
      notificationId: null,
      target: null,
    });
    expect(
      pushMessageOf({ target: { screen: "order", params: { orderId: "1" } } }).target,
    ).toBeNull();
    expect(pushMessageOf({ target: { screen: "catalog" } }).target).toBeNull();
  });
});

describe("M-PUSH-01: when the sheet is shown", () => {
  const undetermined = { status: "undetermined", canAskAgain: true } as const;

  it("after the first order and once more, never a third time", () => {
    expect(shouldOfferPush(undetermined, 0)).toBe(true);
    expect(shouldOfferPush(undetermined, 1)).toBe(true);
    expect(shouldOfferPush(undetermined, PUSH_OFFER_LIMIT)).toBe(false);
  });

  it("never when allowed, refused by the system for good, or not known", () => {
    expect(shouldOfferPush({ status: "granted", canAskAgain: false }, 0)).toBe(false);
    expect(shouldOfferPush({ status: "denied", canAskAgain: false }, 0)).toBe(false);
    expect(shouldOfferPush({ status: "denied", canAskAgain: true }, 0)).toBe(true);
    expect(shouldOfferPush(null, 0)).toBe(false);
  });

  it("counts per account on this device, and reads what it kept", () => {
    let offers = offeredOnce({}, "a");
    offers = offeredOnce(offers, "a");
    offers = offeredOnce(offers, "a");
    expect(offers).toEqual({ a: 2 });
    expect(offeredOnce(offers, "b")).toEqual({ a: 2, b: 1 });
    expect(parsePushOffers({ a: 1, b: "x", c: 9 })).toEqual({ a: 1, c: 2 });
    expect(parsePushOffers(null)).toEqual({});
  });
});

describe("the promise on the screen of an order (I455)", () => {
  it("says «Сообщим» only to a person whose push is allowed", () => {
    expect(pushPromised({ status: "granted", canAskAgain: false })).toBe(true);
    expect(pushPromised({ status: "undetermined", canAskAgain: true })).toBe(false);
    expect(withPushPromise("orderStatus.acceptedPickup.text", true)).toBe(
      "orderStatus.acceptedPickup.textPush",
    );
    expect(withPushPromise("orderStatus.termConfirmed.text", true)).toBe(
      "orderStatus.termConfirmed.textPush",
    );
    expect(withPushPromise("orderStatus.acceptedPickup.text", false)).toBe(
      "orderStatus.acceptedPickup.text",
    );
    expect(withPushPromise("orderStatus.created.text", true)).toBe("orderStatus.created.text");
  });
});

describe("the stub port of the browser and the tests", () => {
  it("asks once, then gives a token; plays a push received and opened", async () => {
    const { port, control } = createStubPushPort();
    expect(await port.permission()).toEqual({ status: "undetermined", canAskAgain: true });
    expect(await port.deviceToken()).toBeNull();
    expect((await port.request()).status).toBe("granted");
    expect((await port.deviceToken())?.token).toBe(control.token);

    const received: unknown[] = [];
    port.onReceived((message) => received.push(message));
    control.receive({
      notificationId: NOTIFICATION,
      target: { screen: "order", params: { orderId: ORDER } },
    });
    expect(received).toHaveLength(1);

    // Opened before anybody listens: the cold start's push.
    control.open({ notificationId: NOTIFICATION, target: { screen: "subscription" } });
    expect((await port.initialOpened())?.target).toEqual({ screen: "subscription" });
    expect(await port.initialOpened()).toBeNull();
  });

  it("answers what the check says the system would", async () => {
    const { port, control } = createStubPushPort();
    control.answer = "denied";
    expect(await port.request()).toEqual({ status: "denied", canAskAgain: false });
    expect(await port.deviceToken()).toBeNull();
  });
});
