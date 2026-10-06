/**
 * The camera of the scanner (S-SCAN-01, TASK-033): the back camera of a
 * phone (or the camera of a laptop), the torch where the browser can
 * switch it, and the decoding of QR codes — on the device, never by
 * sending a picture anywhere. `BarcodeDetector` where the browser has it
 * for QR codes (Chrome on Android), otherwise jsQR on a canvas (Safari on
 * iPhone has no `BarcodeDetector`); jsQR is loaded only when needed.
 */

/** Why there is no camera picture: each has its own words and its own way out. */
export type CameraProblem =
  /** The person or the browser refused the permission. */
  | "denied"
  /** No camera at all (a desktop without one). */
  | "noCamera"
  /** Another app or tab holds the camera. */
  | "busy"
  /** Not a secure context: the browser gives no camera over plain HTTP. */
  | "insecure"
  /** The browser has no camera API. */
  | "unsupported"
  | "failed";

/** The camera API is there at all, or why not. */
export function cameraApiProblem(env: {
  isSecureContext: boolean;
  hasGetUserMedia: boolean;
}): CameraProblem | null {
  if (!env.isSecureContext) return "insecure";
  if (!env.hasGetUserMedia) return "unsupported";
  return null;
}

/** What `getUserMedia` refused with, by the standard names of its errors. */
export function cameraProblemOf(error: unknown): CameraProblem {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "noCamera";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    default:
      return "failed";
  }
}

export function browserCameraProblem(): CameraProblem | null {
  return cameraApiProblem({
    isSecureContext: typeof window !== "undefined" && window.isSecureContext,
    hasGetUserMedia: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
  });
}

/**
 * Whether the device has a camera at all: `false` only when the browser
 * lists its devices and none is a camera (a desktop) — then the manual
 * entry opens at once instead of asking for a permission in vain.
 */
export async function deviceHasCamera(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === "videoinput");
  } catch {
    return true;
  }
}

export async function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** The torch is there only when the track says it can switch it (not in Safari). */
export function torchSupported(stream: MediaStream): boolean {
  const track = stream.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
  return capabilities?.torch === true;
}

export async function setTorch(stream: MediaStream, on: boolean): Promise<void> {
  const track = stream.getVideoTracks()[0];
  await track?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
}

// --------------------------------------------------------------- decoding

/**
 * The square of the frame the decoder looks at — the frame drawn on the
 * screen (DESIGN 7.10: 70 % of the smaller side) with a margin — scaled
 * down to at most `max` pixels: a phone decodes it several times a second.
 */
export function cropOf(
  width: number,
  height: number,
  max = 480,
): { sx: number; sy: number; size: number; scaled: number } {
  const size = Math.round(Math.min(width, height) * 0.85);
  return {
    sx: Math.round((width - size) / 2),
    sy: Math.round((height - size) / 2),
    size,
    scaled: Math.min(size, max),
  };
}

export interface QrDecoder {
  /** The text of a QR in the current video frame, or `null`. */
  decode(video: HTMLVideoElement): Promise<string | null>;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

async function nativeDecoder(): Promise<QrDecoder | null> {
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (!Detector) return null;
  try {
    const formats = (await Detector.getSupportedFormats?.()) ?? [];
    if (!formats.includes("qr_code")) return null;
    const detector = new Detector({ formats: ["qr_code"] });
    return {
      async decode(video) {
        const found = await detector.detect(video);
        return found[0]?.rawValue ?? null;
      },
    };
  } catch {
    return null;
  }
}

async function canvasDecoder(): Promise<QrDecoder> {
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return {
    async decode(video) {
      if (!context || video.videoWidth === 0) return null;
      const { sx, sy, size, scaled } = cropOf(video.videoWidth, video.videoHeight);
      if (canvas.width !== scaled) {
        canvas.width = scaled;
        canvas.height = scaled;
      }
      context.drawImage(video, sx, sy, size, size, 0, 0, scaled, scaled);
      const image = context.getImageData(0, 0, scaled, scaled);
      // The customer's QR is dark on white (DESIGN 7.10): no inverted pass.
      return jsQR(image.data, scaled, scaled, { inversionAttempts: "dontInvert" })?.data ?? null;
    },
  };
}

export async function createDecoder(): Promise<QrDecoder> {
  return (await nativeDecoder()) ?? canvasDecoder();
}
