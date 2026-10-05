/**
 * What the list of sessions calls this browser («Safari · iPhone»): sent as
 * `deviceName` at sign-in, so an employee or an administrator can tell the
 * cabinet's sessions apart (ARCHITECTURE 4.6 I44). Not an identifier.
 */
export function deviceName(userAgent: string, maxTouchPoints = 0): string {
  const system = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Macintosh/.test(userAgent)
            ? "Mac"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;
  const browser = /EdgA?\//.test(userAgent)
    ? "Edge"
    : /YaBrowser\//.test(userAgent)
      ? "Yandex Browser"
      : /SamsungBrowser\//.test(userAgent)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS\//.test(userAgent)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(userAgent)
            ? "Chrome"
            : /Safari\//.test(userAgent)
              ? "Safari"
              : null;
  return [browser, system].filter(Boolean).join(" · ") || "Browser";
}
