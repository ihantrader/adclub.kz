import { describe, expect, it } from "vitest";
import { createScreenLight, type ScreenLightDevice } from "./screen-light";

// Plain Node checks of M-ORD-04's brightness and «screen does not go dark»
// (TASK-030, AC-5): whatever the order of focus, blur, background, return
// and teardown, the person's brightness comes back.

function fakeDevice(start = 0.4) {
  const log: string[] = [];
  const state = { brightness: start, awake: false };
  const device: ScreenLightDevice = {
    readBrightness: async () => state.brightness,
    setBrightness: async (value) => {
      state.brightness = value;
      log.push(`set ${value}`);
    },
    restoreBrightness: async (previous) => {
      if (previous !== null) state.brightness = previous;
      log.push(`restore ${previous}`);
    },
    keepAwake: async (on) => {
      state.awake = on;
      log.push(`awake ${on}`);
    },
  };
  return { device, state, log };
}

describe("the full-screen QR's light", () => {
  it("raises the brightness and keeps the screen awake, then puts both back", async () => {
    const { device, state } = fakeDevice(0.4);
    const light = createScreenLight(device);
    await light.enter();
    expect(state).toEqual({ brightness: 1, awake: true });
    await light.leave();
    expect(state).toEqual({ brightness: 0.4, awake: false });
  });

  it("puts back the person's brightness, never the raised one, however often it is entered", async () => {
    const { device, state } = fakeDevice(0.3);
    const light = createScreenLight(device);
    await light.enter();
    await light.enter(); // focus and «back to the foreground» both say enter
    await light.leave();
    expect(state.brightness).toBe(0.3);
  });

  it("comes back on the background and goes up again on return", async () => {
    const { device, state } = fakeDevice(0.5);
    const light = createScreenLight(device);
    await light.enter();
    await light.leave(); // the app sent to the background
    expect(state).toEqual({ brightness: 0.5, awake: false });
    await light.enter(); // back
    expect(state).toEqual({ brightness: 1, awake: true });
    await light.leave(); // closed
    await light.leave(); // and torn down
    expect(state).toEqual({ brightness: 0.5, awake: false });
  });

  it("keeps the order asked for, even when the calls are not awaited", async () => {
    const { device, state } = fakeDevice(0.2);
    const light = createScreenLight(device);
    void light.enter();
    void light.leave();
    void light.enter();
    await light.leave();
    expect(state).toEqual({ brightness: 0.2, awake: false });
    expect(light.isRaised()).toBe(false);
  });

  it("does nothing on leaving what was never entered, and survives a device that refuses", async () => {
    const { device, log } = fakeDevice();
    const light = createScreenLight(device);
    await light.leave();
    expect(log).toEqual([]);

    const refusing = createScreenLight({
      readBrightness: () => Promise.reject(new Error("no")),
      setBrightness: () => Promise.reject(new Error("no")),
      restoreBrightness: () => Promise.reject(new Error("no")),
      keepAwake: () => Promise.reject(new Error("no")),
    });
    await expect(refusing.enter()).resolves.toBeUndefined();
    await expect(refusing.leave()).resolves.toBeUndefined();
  });
});
