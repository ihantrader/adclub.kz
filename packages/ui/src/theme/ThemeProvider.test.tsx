import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeProvider";

let systemDark = false;
const mediaListeners = new Set<() => void>();

beforeEach(() => {
  systemDark = false;
  mediaListeners.clear();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return systemDark;
    },
    addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe() {
  const { mode, setMode, theme } = useTheme();
  return (
    <>
      <span data-testid="theme">{`${mode}:${theme.name}`}</span>
      <button onClick={() => setMode("dark")}>dark</button>
      <button onClick={() => setMode("system")}>system</button>
    </>
  );
}

const choose = (mode: "dark" | "system") =>
  act(() => fireEvent.click(screen.getByRole("button", { name: mode })));

const renderProvider = (storageKey = "adclub.supplier-web.theme") =>
  render(
    <ThemeProvider storageKey={storageKey} defaultMode="light">
      <Probe />
    </ThemeProvider>,
  );

describe("web ThemeProvider", () => {
  it("starts light in the cabinet and admin", () => {
    renderProvider();
    expect(screen.getByTestId("theme").textContent).toBe("light:light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("switches immediately and remembers the choice", () => {
    renderProvider();
    choose("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem("adclub.supplier-web.theme")).toBe("dark");
    cleanup();
    renderProvider();
    expect(screen.getByTestId("theme").textContent).toBe("dark:dark");
  });

  it("follows the system scheme while it changes", () => {
    renderProvider();
    choose("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => {
      systemDark = true;
      mediaListeners.forEach((listener) => listener());
    });
    expect(screen.getByTestId("theme").textContent).toBe("system:dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("keeps separate choices for the cabinet and the admin panel", () => {
    renderProvider("adclub.supplier-web.theme");
    choose("dark");
    cleanup();
    renderProvider("adclub.admin-web.theme");
    expect(screen.getByTestId("theme").textContent).toBe("light:light");
  });

  it("works with the default theme when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    renderProvider();
    expect(screen.getByTestId("theme").textContent).toBe("light:light");
    choose("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
