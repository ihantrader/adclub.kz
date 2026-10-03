/**
 * The full-screen QR at a counter (M-ORD-04, SCREENS 9.2, DESIGN 7.10):
 * the brightness goes to the maximum and the screen does not go dark while
 * it is open, and both come back the moment it is not on screen — left,
 * the app sent to the background, the screen torn down.
 *
 * The rule lives here, without React Native, so that «comes back» is a
 * tested property rather than a hope: `enter` and `leave` may be called in
 * any order and any number of times (focus, blur, background, foreground,
 * unmount all call them), and the brightness the person had is restored
 * exactly once for every time it was raised, and never set to a value read
 * while it was already raised.
 */
export interface ScreenLightDevice {
  /** The brightness of the app's screen now, 0…1; `null` — unknown. */
  readBrightness(): Promise<number | null>;
  setBrightness(value: number): Promise<void>;
  /** Back to what the system decides (Android: the window follows the system again). */
  restoreBrightness(previous: number | null): Promise<void>;
  keepAwake(on: boolean): Promise<void>;
}

export interface ScreenLight {
  /** The screen is on show: brightness up, no sleep. */
  enter(): Promise<void>;
  /** The screen is not on show: everything back as it was. */
  leave(): Promise<void>;
  isRaised(): boolean;
}

export function createScreenLight(device: ScreenLightDevice): ScreenLight {
  let raised = false;
  let previous: number | null = null;
  // One change at a time, in the order asked: an `enter` and a `leave` a
  // frame apart (a quick blur) must not finish the other way round.
  let line: Promise<void> = Promise.resolve();
  const run = (work: () => Promise<void>) => {
    line = line.then(work, work).catch(() => undefined);
    return line;
  };

  return {
    isRaised: () => raised,
    enter: () =>
      run(async () => {
        if (raised) return;
        raised = true;
        previous = await device.readBrightness().catch(() => null);
        await Promise.allSettled([device.keepAwake(true), device.setBrightness(1)]);
      }),
    leave: () =>
      run(async () => {
        if (!raised) return;
        raised = false;
        const was = previous;
        previous = null;
        await Promise.allSettled([device.keepAwake(false), device.restoreBrightness(was)]);
      }),
  };
}
