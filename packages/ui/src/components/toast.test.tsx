import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { motion, TOAST_ACTION_LIFETIME } from "@adclub/ui-core";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, toastArea, toastObstacle, useToast, type ToastAction } from "./feedback";
import { BottomTabs } from "./navigation";

/**
 * DESIGN 7.7 «Всплывающее сообщение» (TASK-032): above the bottom tabs and
 * a pinned main button with a gap of 8, never on them; centered on the
 * content area next to a side menu; one with «Отменить» stays while looked at.
 */

const rects = new Map<string, Partial<DOMRect>>();

function rectOf(element: Element): DOMRect {
  const key = element.getAttribute("data-rect") ?? element.className.toString();
  const rect = rects.get(key) ?? { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  return { x: 0, y: 0, toJSON: () => rect, ...rect } as DOMRect;
}

beforeEach(() => {
  vi.useFakeTimers();
  rects.clear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 780 });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Show({ text, action }: { text: string; action?: ToastAction }) {
  const toast = useToast();
  useEffect(() => {
    toast.show(text, action ? { action } : undefined);
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function region(): HTMLElement {
  return document.querySelector(".ac-toast-region") as HTMLElement;
}

describe("where a toast stands", () => {
  it("stands 8 above the bottom tabs and their raised center button, not on them", () => {
    // The tab bar from 682 (64 + a 34 safe area), the raised scanner button from 662.
    rects.set("ac-tabs", { top: 682, bottom: 780, left: 0, right: 360, width: 360, height: 98 });
    rects.set("ac-tab__center-button", { top: 662, bottom: 718, width: 56, height: 56 });
    render(
      <ToastProvider>
        <BottomTabs
          label="Разделы"
          items={[
            { key: "orders", label: "Заявки", icon: "receipt" },
            { key: "more", label: "Ещё", icon: "dots" },
          ]}
          active="orders"
          onSelect={() => undefined}
          center={{ key: "scan", label: "Сканер", icon: "scan" }}
        />
        <Show text="Сохранено" />
      </ToastProvider>,
    );
    expect(screen.getByText("Сохранено")).toBeTruthy();
    // 780 − 662 + 8: the toast's bottom edge is 8 above the raised button.
    expect(region().style.bottom).toBe("126px");
  });

  it("stands above a pinned main button of the page too", () => {
    rects.set("ac-tabs", { top: 682, width: 360, height: 98 });
    rects.set("save-bar", { top: 610, width: 360, height: 72 });
    render(
      <ToastProvider>
        <nav className="ac-tabs" {...toastObstacle} />
        <div data-rect="save-bar" {...toastObstacle} />
        <Show text="Сохранено" />
      </ToastProvider>,
    );
    expect(region().style.bottom).toBe("178px");
  });

  it("keeps the CSS place above the safe area when nothing is pinned, or the tabs are hidden", () => {
    // From 1024 px the tabs are `display: none` — no box.
    render(
      <ToastProvider>
        <nav className="ac-tabs" {...toastObstacle} />
        <Show text="Сохранено" />
      </ToastProvider>,
    );
    expect(region().style.bottom).toBe("");
  });

  it("centers on the content area next to a side menu", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    rects.set("content", { top: 0, left: 240, right: 1280, width: 1040, height: 780 });
    render(
      <ToastProvider>
        <div data-rect="content" {...toastArea} />
        <Show text="Сохранено" />
      </ToastProvider>,
    );
    expect(region().style.left).toBe("256px");
    expect(region().style.right).toBe("16px");
  });
});

describe("how long a toast stays", () => {
  it("takes a plain confirmation away after its lifetime", () => {
    render(
      <ToastProvider>
        <Show text="Код скопирован" />
      </ToastProvider>,
    );
    act(() => vi.advanceTimersByTime(motion.toast - 1));
    expect(screen.queryByText("Код скопирован")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Код скопирован")).toBeNull();
  });

  it("keeps «Отменить» longer, not at all while looked at, and runs it once", () => {
    const undo = vi.fn();
    render(
      <ToastProvider>
        <Show text="Сохранено" action={{ label: "Отменить", onAction: undo }} />
      </ToastProvider>,
    );
    act(() => vi.advanceTimersByTime(motion.toast + 1));
    const toast = screen.getByText("Сохранено").closest(".ac-toast")!;
    expect(toast).toBeTruthy();

    // A pointer (or a finger) on it: it stays however long.
    fireEvent.pointerEnter(toast);
    act(() => vi.advanceTimersByTime(TOAST_ACTION_LIFETIME * 3));
    expect(screen.queryByText("Сохранено")).toBeTruthy();
    fireEvent.pointerLeave(toast);
    act(() => vi.advanceTimersByTime(TOAST_ACTION_LIFETIME - 1));
    expect(screen.queryByText("Сохранено")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Сохранено")).toBeNull();
  });

  it("stays while the page is in the background, and coming back doesn't drop a pointer on it", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    render(
      <ToastProvider>
        <Show text="Сохранено" action={{ label: "Отменить", onAction: () => undefined }} />
      </ToastProvider>,
    );
    const toast = screen.getByText("Сохранено").closest(".ac-toast")!;
    fireEvent.pointerEnter(toast);
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(TOAST_ACTION_LIFETIME * 2));
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    // Back on screen, the pointer still over it: it stays.
    act(() => vi.advanceTimersByTime(TOAST_ACTION_LIFETIME * 2));
    expect(screen.queryByText("Сохранено")).toBeTruthy();
    fireEvent.pointerLeave(toast);
    act(() => vi.advanceTimersByTime(TOAST_ACTION_LIFETIME));
    expect(screen.queryByText("Сохранено")).toBeNull();
  });
});
