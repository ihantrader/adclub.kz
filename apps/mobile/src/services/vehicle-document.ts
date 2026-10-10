import { VEHICLE_DOCUMENT_MAX_SIDE_PX } from "@adclub/contracts";
import type { VehicleDocumentAttempts, VehicleDocumentResponse } from "@adclub/contracts";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import { createDeviceStore } from "../state/device-store";
import { sessionStore } from "../state/stores";
import { apiClient } from "./api";

/**
 * A photographed registration certificate on its way to the server (D-064,
 * TASK-057; SCREENS M-GAR-04). The photo is made smaller on the phone
 * (`VEHICLE_DOCUMENT_MAX_SIDE_PX`, JPEG) before it leaves it, travels in one
 * request, and every copy the phone made of it — the camera's file, the
 * smaller one — is deleted at once, sent or not: nothing goes to the
 * gallery, the cache or the app's storage. Only the bytes held in memory
 * for the request remain, until it answers.
 */

/**
 * The id a guest's trial recognitions are counted by (PRODUCT 6.6): made
 * once per installation, not a secret and not personal — a new
 * installation is a new device, which PRODUCT accepts at the start.
 */
const deviceIdStore = createDeviceStore<string | null>(
  {
    read: (key) => AsyncStorage.getItem(key),
    write: (key, value) => AsyncStorage.setItem(key, value),
  },
  {
    key: "adclub.mobile.device-id",
    initial: null,
    parse: (raw) => (typeof raw === "string" && /^[0-9a-f-]{36}$/i.test(raw) ? raw : null),
  },
);

async function deviceId(): Promise<string> {
  await deviceIdStore.ready;
  const known = deviceIdStore.get();
  if (known) return known;
  const made = randomUUID();
  deviceIdStore.set(made);
  return made;
}

function signedIn(): boolean {
  return sessionStore.get().status === "signed_in";
}

/**
 * A copy of the photo the app made on the phone's disk — the camera's file,
 * the gallery's copy, the smaller one — deleted as soon as it is not needed.
 * Only what is in the app's own cache: the person's gallery is theirs.
 * Nothing to delete on the web (no files).
 */
function forget(uri: string | undefined): void {
  if (!uri || Platform.OS === "web" || !uri.startsWith(Paths.cache.uri)) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // A copy that is already gone is what was wanted.
  }
}

function bytesOfBase64(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The photo, smaller, as JPEG bytes in memory. `source` is the camera's or
 * the gallery's picture: a picture the app itself made (the camera's file)
 * is deleted with the smaller copy; the gallery's original is the person's
 * own and stays where it is.
 */
export async function preparedSnapshot(
  source: { uri: string; width?: number; height?: number },
  ownFile: boolean,
): Promise<Uint8Array> {
  let rendered: string | undefined;
  try {
    const context = ImageManipulator.manipulate(source.uri);
    const longest = Math.max(source.width ?? 0, source.height ?? 0);
    if (longest === 0 || longest > VEHICLE_DOCUMENT_MAX_SIDE_PX) {
      const landscape = (source.width ?? 1) >= (source.height ?? 0);
      context.resize(
        landscape
          ? { width: VEHICLE_DOCUMENT_MAX_SIDE_PX }
          : { height: VEHICLE_DOCUMENT_MAX_SIDE_PX },
      );
    }
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: true });
    rendered = saved.uri;
    if (!saved.base64) throw new Error("The smaller photo has no data");
    return bytesOfBase64(saved.base64.replace(/^data:[^,]*,/, ""));
  } finally {
    forget(rendered);
    if (ownFile) forget(source.uri);
  }
}

/**
 * A photo from the gallery, or `null` when the person changed their mind.
 * Called in the tap itself: a browser opens a file dialog only then.
 */
export async function pickFromGallery(): Promise<{
  uri: string;
  width: number;
  height: number;
} | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 1,
    exif: false,
    allowsEditing: false,
    allowsMultipleSelection: false,
  });
  const asset = picked.canceled ? undefined : picked.assets[0];
  return asset ? { uri: asset.uri, width: asset.width, height: asset.height } : null;
}

/** Reads the certificate; the attempts of a guest are counted by this device. */
export async function recognizeDocument(bytes: Uint8Array): Promise<VehicleDocumentResponse> {
  const query = signedIn() ? {} : { deviceId: await deviceId() };
  return apiClient.recognizeVehicleDocument(bytes, { query, contentType: "image/jpeg" });
}

/** How many recognitions are left (T-GAR-04). */
export async function documentAttempts(): Promise<VehicleDocumentAttempts> {
  const query = signedIn() ? {} : { deviceId: await deviceId() };
  return apiClient.getVehicleDocumentAttempts({ query });
}
