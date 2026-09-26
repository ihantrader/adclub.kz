import { describe, expect, it } from "vitest";
import { isOnline } from "./network";

describe("isOnline", () => {
  it("is online when the device is connected and the internet is reachable", () => {
    expect(isOnline({ isConnected: true, isInternetReachable: true })).toBe(true);
  });

  it("is offline when the device says it is not connected", () => {
    expect(isOnline({ isConnected: false, isInternetReachable: false })).toBe(false);
    expect(isOnline({ isConnected: false })).toBe(false);
  });

  it("is offline on a connection that reaches nothing (a captive Wi-Fi)", () => {
    expect(isOnline({ isConnected: true, isInternetReachable: false })).toBe(false);
  });

  it("treats an unknown state as online instead of blocking the app", () => {
    expect(isOnline(null)).toBe(true);
    expect(isOnline(undefined)).toBe(true);
    expect(isOnline({})).toBe(true);
    expect(isOnline({ isConnected: true, isInternetReachable: null })).toBe(true);
  });
});
