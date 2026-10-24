import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionBar } from "./ActionBar";
import { fitsInHalves } from "./action-bar-core";
import { Button } from "./Button";

afterEach(cleanup);

const css = readFileSync(join(__dirname, "../styles/components.css"), "utf8");

/** The declarations of `selector` outside any media query, or inside the one given. */
function rule(selector: string, media?: string): string {
  const scope = media ? blockAfter(`@media ${media} {`) : stripMedia(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|[},\\s])${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "m").exec(scope);
  return found?.[1] ?? "";
}

function blockAfter(head: string): string {
  let text = "";
  let from = 0;
  for (;;) {
    const start = css.indexOf(head, from);
    if (start < 0) return text;
    let depth = 0;
    let index = start + head.length - 1;
    for (; index < css.length; index++) {
      if (css[index] === "{") depth++;
      if (css[index] === "}" && --depth === 0) break;
    }
    text += css.slice(start + head.length, index) + "\n";
    from = index;
  }
}

function stripMedia(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const media = text.indexOf("@media", index);
    if (media < 0) return out + text.slice(index);
    out += text.slice(index, media);
    let depth = 0;
    let at = text.indexOf("{", media);
    for (; at < text.length; at++) {
      if (text[at] === "{") depth++;
      if (text[at] === "}" && --depth === 0) break;
    }
    index = at + 1;
  }
  return out;
}

function bar(others: number, main = true) {
  const labels = ["Выдать по QR / коду", "Отказать", "Позвонить"];
  return render(
    <ActionBar
      main={main ? <Button>Готово к выдаче</Button> : undefined}
      others={labels.slice(0, others).map((label) => (
        <Button key={label} variant="secondary">
          {label}
        </Button>
      ))}
    />,
  ).container.firstElementChild as HTMLElement;
}

describe("ActionBar (C1)", () => {
  it("one button: the main action alone, first in reading order", () => {
    const element = bar(0);
    expect(element.classList.contains("ac-action-bar--others-0")).toBe(true);
    expect(element.querySelector(".ac-action-bar__others")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Готово к выдаче"]);
  });

  it("two buttons: the main on top, then the other", () => {
    const element = bar(1);
    expect(element.classList.contains("ac-action-bar--others-1")).toBe(true);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Готово к выдаче",
      "Выдать по QR / коду",
    ]);
  });

  it("three buttons: the main on top, two others side by side", () => {
    const element = bar(2);
    expect(element.classList.contains("ac-action-bar--others-2")).toBe(true);
    const others = element.querySelector(".ac-action-bar__others");
    expect(others?.children).toHaveLength(2);
    expect(screen.getAllByRole("button")[0]?.textContent).toBe("Готово к выдаче");
  });

  it("three others: each its own line (class --others-3)", () => {
    const element = bar(3);
    expect(element.classList.contains("ac-action-bar--others-3")).toBe(true);
    expect(element.querySelector(".ac-action-bar__others")?.children).toHaveLength(3);
  });

  it("no main and no others — nothing at all; null others are skipped", () => {
    const { container } = render(<ActionBar others={[null, false]} />);
    expect(container.firstChild).toBeNull();
  });

  it("a pinned bar stands above the tabs and is an obstacle for a toast", () => {
    const { container } = render(<ActionBar pinned main={<Button>Сохранить</Button>} />);
    const element = container.firstElementChild as HTMLElement;
    expect(element.classList.contains("ac-action-bar--pinned")).toBe(true);
    expect(element.hasAttribute("data-ac-toast-obstacle")).toBe(true);
  });

  it("under 600 px: a column, every button L across, one column of others unless measured halves", () => {
    expect(rule(".ac-action-bar__buttons")).toContain("flex-direction: column");
    expect(rule(".ac-action-bar .ac-button")).toContain("width: 100%");
    expect(rule(".ac-action-bar .ac-button")).toContain("min-height: var(--ac-button-l)");
    expect(rule(".ac-action-bar__others")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule(".ac-action-bar__others--halves")).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
    // The fixed floor of a half is gone: the labels decide (TASK-079.A).
    expect(css).not.toContain("136px");
  });

  it("from 600 px: one row on the right; a --column bar (stacked, a card pair) stays a column", () => {
    const wide = "(min-width: 600px)";
    const row = ".ac-action-bar:not(.ac-action-bar--column)";
    expect(rule(`${row} .ac-action-bar__buttons`, wide)).toContain("flex-direction: row-reverse");
    expect(rule(`${row} .ac-action-bar__buttons`, wide)).toContain("justify-content: flex-start");
    expect(rule(`${row} .ac-button`, wide)).toContain("width: auto");
    // Nothing turns a bar without a main action, or a stacked one, into a row.
    const selectors = [...blockAfter(`@media ${wide} {`).matchAll(/([^{}]+)\{/g)].map((found) =>
      (found[1] ?? "").trim(),
    );
    const layoutRules = selectors.filter(
      (selector) =>
        selector.startsWith(".ac-action-bar") &&
        /__(buttons|others|note)$|\.ac-button$/.test(selector),
    );
    expect(layoutRules.length).toBeGreaterThan(0);
    for (const selector of layoutRules) {
      if (selector === ".ac-action-bar .ac-button") continue;
      expect(selector.startsWith(row)).toBe(true);
    }
    expect(rule(".ac-action-bar .ac-button", wide)).toContain("min-height: var(--ac-button-m)");
    expect(rule(".ac-action-bar .ac-button", wide)).not.toContain("width");
  });

  it("a column at any width: stacked, and two actions of a card with no main action", () => {
    const column = (element: HTMLElement) => element.classList.contains("ac-action-bar--column");
    expect(column(bar(2, false))).toBe(true);
    cleanup();
    // One action of a card (Выйти, Скачать .xlsx) keeps its own width on a computer.
    expect(column(bar(1, false))).toBe(false);
    cleanup();
    expect(column(bar(2))).toBe(false);
    cleanup();
    const stacked = render(
      <ActionBar
        stacked
        main={<Button>Выдать</Button>}
        others={[<Button key="c">Отмена</Button>]}
      />,
    ).container.firstElementChild as HTMLElement;
    expect(column(stacked)).toBe(true);
  });

  it("pinned: clear of the raised center button, in the flow from 1024", () => {
    expect(rule(".ac-action-bar--pinned")).toContain("var(--ac-center-tab-lift)");
    const desktop = rule(".ac-action-bar--pinned", "(min-width: 1024px)");
    expect(desktop).toContain("position: relative");
    // The sticky offset would shift a relative bar up over the content above it.
    expect(desktop).toContain("bottom: auto");
  });
});

/** Text widths jsdom can't measure: the container and each hidden copy by its label. */
function layout(container: number, widths: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    let width = 0;
    if (this.classList.contains("ac-action-bar__others")) width = container;
    if (this.classList.contains("ac-action-bar__measure-item")) {
      width = widths[this.textContent ?? ""] ?? 0;
    }
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect;
  });
}

function pair(labels: readonly string[], props: { main?: boolean; stacked?: boolean } = {}) {
  const element = render(
    <ActionBar
      stacked={props.stacked}
      main={props.main ? <Button>Готово к выдаче</Button> : undefined}
      others={labels.map((text) => (
        <Button key={text} variant="secondary">
          {text}
        </Button>
      ))}
    />,
  ).container.firstElementChild as HTMLElement;
  return element.querySelector(".ac-action-bar__others") as HTMLElement;
}

const halves = (others: HTMLElement) => others.classList.contains("ac-action-bar__others--halves");

describe("ActionBar: two others in halves only while each label fits (TASK-079.A)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("two short labels — halves", () => {
    // A phone of 390: 358 across, a half 175.
    layout(358, { Отказать: 112, Позвонить: 128 });
    expect(halves(pair(["Отказать", "Позвонить"]))).toBe(true);
  });

  it("one long label — both across, one under the other", () => {
    layout(358, { "Выдать по QR / коду": 186, Отказать: 112 });
    expect(halves(pair(["Выдать по QR / коду", "Отказать"]))).toBe(false);
  });

  it("a narrow container on a wide window decides by the container", () => {
    window.innerWidth = 1440;
    const labels = ["Выдать по QR / коду", "Отказать"];
    const widths = { "Выдать по QR / коду": 186, Отказать: 112 };
    // The side column of the order card at 1440.
    layout(360, widths);
    expect(halves(pair(labels, { main: true, stacked: true }))).toBe(false);
    cleanup();
    // The same buttons in a wide container stand side by side.
    layout(560, widths);
    expect(halves(pair(labels, { main: true, stacked: true }))).toBe(true);
  });

  it("three others — each across, nothing measured", () => {
    layout(1200, { Отказать: 112, Позвонить: 128, Готово: 100 });
    const element = render(
      <ActionBar
        others={["Отказать", "Позвонить", "Готово"].map((text) => (
          <Button key={text} variant="secondary">
            {text}
          </Button>
        ))}
      />,
    ).container.firstElementChild as HTMLElement;
    expect(halves(element.querySelector(".ac-action-bar__others") as HTMLElement)).toBe(false);
    expect(element.querySelector(".ac-action-bar__measure")).toBeNull();
  });

  it("unmeasured widths — each across, so a label never wraps even for a frame", () => {
    layout(358, {});
    expect(halves(pair(["Отказать", "Позвонить"]))).toBe(false);
  });

  it("the hidden copies are out of the accessibility tree and inert", () => {
    layout(358, { Отказать: 112, Позвонить: 128 });
    const others = pair(["Отказать", "Позвонить"]);
    const copies = others.closest(".ac-action-bar")?.querySelector(".ac-action-bar__measure");
    expect(copies?.getAttribute("aria-hidden")).toBe("true");
    expect(copies?.hasAttribute("inert")).toBe(true);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Отказать",
      "Позвонить",
    ]);
  });

  it("no button is taller than its size: the label never wraps, heights are only L and M", () => {
    expect(rule(".ac-action-bar .ac-button__label")).toContain("white-space: nowrap");
    const heights = [...css.matchAll(/\.ac-action-bar[^{]*\.ac-button\s*\{([^}]*)\}/g)]
      .map((found) => found[1] ?? "")
      .flatMap((body) => [...body.matchAll(/(?:min-)?height:\s*([^;]+);/g)].map((m) => m[1]));
    expect(heights.length).toBeGreaterThan(0);
    for (const height of heights) {
      expect(["var(--ac-button-l)", "var(--ac-button-m)"]).toContain(height);
    }
  });
});

describe("fitsInHalves", () => {
  it("each width against its half of the container, minus the gap", () => {
    // (358 − 8) / 2 = 175: 174 fits with the slack of 1, 175 does not.
    expect(fitsInHalves(358, [174, 100])).toBe(true);
    expect(fitsInHalves(358, [175, 100])).toBe(false);
    expect(fitsInHalves(358, [100, 175])).toBe(false);
    expect(fitsInHalves(0, [10, 10])).toBe(false);
    expect(fitsInHalves(358, [0, 10])).toBe(false);
  });
});
