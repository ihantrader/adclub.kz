import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { SkeletonList } from "./feedback";
import { FadeSwap, LoadingContent, useLoadingGate } from "./loading";

/**
 * DESIGN 7.6 «Загрузка без мигания» on the web (D-069, TASK-032.A): the
 * rule itself is tested in `@adclub/ui-core`; here — that the components
 * follow it.
 */

let reduce = false;
const animate = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  reduce = false;
  animate.mockReset();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("reduce") && reduce,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a button that saves", () => {
  it("shows no spinner for a quick action: the label stays, presses are ignored meanwhile", async () => {
    let finish: () => void = () => undefined;
    const onClick = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { container } = render(<Button onClick={onClick}>Сохранить</Button>);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    act(() => void vi.advanceTimersByTime(200));
    expect(container.querySelector(".ac-spinner")).toBeNull();
    await act(async () => finish());
    act(() => void vi.advanceTimersByTime(1000));
    expect(container.querySelector(".ac-spinner")).toBeNull();
    expect(button.className).not.toContain("ac-button--spinning");
  });

  it("shows the spinner after 300 ms and keeps it at least 500 ms, the width kept by the label", async () => {
    let finish: () => void = () => undefined;
    const onClick = () => new Promise<void>((resolve) => (finish = resolve));
    const { container } = render(<Button onClick={onClick}>Выставить</Button>);
    fireEvent.click(screen.getByRole("button"));
    act(() => void vi.advanceTimersByTime(300));
    expect(container.querySelector(".ac-spinner")).not.toBeNull();
    // The label is still in the button (hidden by CSS), so the width does not change.
    expect(screen.getByRole("button").textContent).toContain("Выставить");
    act(() => void vi.advanceTimersByTime(50));
    await act(async () => finish());
    act(() => void vi.advanceTimersByTime(400));
    expect(container.querySelector(".ac-spinner")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(50));
    expect(container.querySelector(".ac-spinner")).toBeNull();
  });
});

/** A list of one tab, loaded through the gate the way the cabinet's screens do it. */
function Tabs({ answer }: { answer: (tab: string) => Promise<string[]> }) {
  const gate = useLoadingGate();
  const [tab, setTab] = useState("on_sale");
  const [shown, setShown] = useState<{ tab: string; rows: string[] } | null>(null);
  const open = (next: string) => {
    setTab(next);
    const ticket = gate.begin();
    void answer(next).then((rows) => gate.settle(ticket, () => setShown({ tab: next, rows })));
  };
  return (
    <>
      <button type="button" onClick={() => open("on_sale")}>
        on sale
      </button>
      <button type="button" onClick={() => open("withdrawn")}>
        withdrawn
      </button>
      <span data-testid="tab">{tab}</span>
      <LoadingContent
        ready={shown !== null}
        indicator={gate.indicator}
        skeleton={<SkeletonList rows={2} label="Загрузка" />}
        label="Загрузка"
        swapKey={shown?.tab}
        lock
      >
        <ul>
          {shown?.rows.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      </LoadingContent>
    </>
  );
}

/** Answers the test resolves by hand, in any order. */
function answers() {
  const waiting: Array<{ tab: string; resolve: (rows: string[]) => void }> = [];
  return {
    answer: (tab: string) =>
      new Promise<string[]>((resolve) => {
        waiting.push({ tab, resolve });
      }),
    async reply(index: number, rows: string[]) {
      await act(async () => waiting[index]!.resolve(rows));
    },
  };
}

const firstLoad = () => document.querySelector(".ac-first-load");
const rows = () => [...document.querySelectorAll("li")].map((li) => li.textContent);

describe("LoadingContent", () => {
  it("a quick first answer: no skeleton seen at all, the content fades in from nothing", async () => {
    const server = answers();
    render(<Tabs answer={server.answer} />);
    fireEvent.click(screen.getByText("on sale"));
    expect(firstLoad()?.className).not.toContain("ac-first-load--shown");
    act(() => void vi.advanceTimersByTime(100));
    await server.reply(0, ["Колодки"]);
    expect(rows()).toEqual(["Колодки"]);
    expect(firstLoad()).toBeNull();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]![0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animate.mock.calls[0]![1]).toMatchObject({ duration: 150 });
  });

  it("a slow first answer: the skeleton appears at 300 ms and the content replaces it at 800", async () => {
    const server = answers();
    render(<Tabs answer={server.answer} />);
    fireEvent.click(screen.getByText("on sale"));
    act(() => void vi.advanceTimersByTime(300));
    expect(firstLoad()?.className).toContain("ac-first-load--shown");
    act(() => void vi.advanceTimersByTime(50));
    await server.reply(0, ["Колодки"]);
    expect(rows()).toEqual([]);
    act(() => void vi.advanceTimersByTime(449));
    expect(rows()).toEqual([]);
    act(() => void vi.advanceTimersByTime(1));
    expect(rows()).toEqual(["Колодки"]);
  });

  it("a reload keeps the old content dimmed and locked under the line, then swaps it with a fade", async () => {
    const server = answers();
    render(<Tabs answer={server.answer} />);
    fireEvent.click(screen.getByText("on sale"));
    await server.reply(0, ["Колодки"]);
    animate.mockReset();

    fireEvent.click(screen.getByText("withdrawn"));
    act(() => void vi.advanceTimersByTime(300));
    const content = document.querySelector(".ac-loading__content") as HTMLElement;
    expect(rows()).toEqual(["Колодки"]);
    expect(content.className).toContain("ac-loading__content--dim");
    expect(content.getAttribute("aria-busy")).toBe("true");
    expect(content.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("status", { name: "Загрузка" })).toBeTruthy();

    act(() => void vi.advanceTimersByTime(600));
    await server.reply(1, ["Масло"]);
    expect(rows()).toEqual(["Масло"]);
    expect(content.className).not.toContain("--dim");
    expect(content.hasAttribute("inert")).toBe(false);
    // The same element, not a new one: the new content comes from the dimmed opacity.
    expect(document.querySelector(".ac-loading__content")).toBe(content);
    expect(animate.mock.calls.at(-1)![0]).toEqual([{ opacity: 0.5 }, { opacity: 1 }]);
  });

  it("quick switches one after another show only the last answer, with no indicator", async () => {
    const server = answers();
    render(<Tabs answer={server.answer} />);
    fireEvent.click(screen.getByText("on sale"));
    await server.reply(0, ["Колодки"]);
    fireEvent.click(screen.getByText("withdrawn"));
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.click(screen.getByText("on sale"));
    act(() => void vi.advanceTimersByTime(100));
    await server.reply(2, ["Колодки 2"]);
    await server.reply(1, ["Снятое"]);
    act(() => void vi.advanceTimersByTime(2000));
    expect(rows()).toEqual(["Колодки 2"]);
    expect(document.querySelector(".ac-refresh-line--active")).toBeNull();
  });

  it("«Уменьшить движение»: no fades, the content is simply replaced", async () => {
    reduce = true;
    const server = answers();
    render(<Tabs answer={server.answer} />);
    fireEvent.click(screen.getByText("on sale"));
    await server.reply(0, ["Колодки"]);
    fireEvent.click(screen.getByText("withdrawn"));
    await server.reply(1, ["Масло"]);
    expect(rows()).toEqual(["Масло"]);
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("FadeSwap", () => {
  it("fades the page in when its key changes, without remounting what stays", () => {
    const { rerender } = render(
      <FadeSwap fadeKey="/offers" as="main">
        <p>Предложения</p>
      </FadeSwap>,
    );
    const main = screen.getByRole("main");
    animate.mockReset();
    rerender(
      <FadeSwap fadeKey="/company" as="main">
        <p>Компания</p>
      </FadeSwap>,
    );
    expect(screen.getByRole("main")).toBe(main);
    expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.anything());
    animate.mockReset();
    rerender(
      <FadeSwap fadeKey="/company" as="main">
        <p>Компания, обновлено</p>
      </FadeSwap>,
    );
    expect(animate).not.toHaveBeenCalled();
  });
});
