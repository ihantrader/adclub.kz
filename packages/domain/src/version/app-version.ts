/**
 * Application versions are plain `MAJOR.MINOR.PATCH` numbers (the same
 * shape as `app.json`'s `version` and `package.json`'s `version`). They
 * decide whether a client is still supported (ARCHITECTURE 7.4), so
 * anything that isn't exactly that shape is treated as "unknown" rather
 * than guessed at.
 */
export type AppVersion = readonly [major: number, minor: number, patch: number];

const VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** Returns `null` for anything that isn't a strict `MAJOR.MINOR.PATCH`. */
export function parseAppVersion(value: string): AppVersion | null {
  const match = VERSION_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isValidAppVersion(value: string): boolean {
  return parseAppVersion(value) !== null;
}

/** Negative if `a < b`, zero if equal, positive if `a > b`. */
export function compareAppVersions(a: AppVersion, b: AppVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * `true` only when both versions are valid and `version` is strictly
 * below `minSupported`. An unparsable client version is never reported as
 * outdated: an unknown client must not be locked out (TASK-003 edge case).
 */
export function isVersionBelowMinimum(version: string, minSupported: string): boolean {
  const parsedVersion = parseAppVersion(version);
  const parsedMinimum = parseAppVersion(minSupported);
  if (!parsedVersion || !parsedMinimum) {
    return false;
  }
  return compareAppVersions(parsedVersion, parsedMinimum) < 0;
}
