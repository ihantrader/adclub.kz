import type { ClientCity } from "@adclub/contracts";
import * as Location from "expo-location";
import { matchDetectedCity } from "../state/city";

/**
 * What came out of "Определить автоматически" (M-START-04):
 * - `city` — a city of the list;
 * - `denied` — the system permission was refused (the way out is the list);
 * - `unknown` — a place outside the cities the admin keeps, or no place at
 *   all: the list opens with "Весь Казахстан" selected;
 * - `failed` — the device could not give a position (no signal, service off).
 */
export type DetectionOutcome =
  | { kind: "city"; city: ClientCity }
  | { kind: "denied" }
  | { kind: "unknown" }
  | { kind: "failed" };

/**
 * Asks the system for the location **only when called** — and it is called
 * only from the button (SCREENS 5.1, 2.8): nothing detects on its own, and
 * the city is detected once.
 */
export async function detectCity(cities: readonly ClientCity[]): Promise<DetectionOutcome> {
  let permission: Location.LocationPermissionResponse;
  try {
    permission = await Location.requestForegroundPermissionsAsync();
  } catch {
    return { kind: "failed" };
  }
  if (!permission.granted) {
    return { kind: "denied" };
  }

  try {
    // Low accuracy is enough for a city and is the fastest to get.
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Low,
    });
    const places = await Location.reverseGeocodeAsync({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
    const names = places.flatMap((place) => [place.city, place.subregion, place.region]);
    const city = matchDetectedCity(names, cities);
    return city ? { kind: "city", city } : { kind: "unknown" };
  } catch {
    return { kind: "failed" };
  }
}
