import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActionBar } from "./ActionBar";
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

  it("under 600 px: a column, every button L across; two others in halves while halves fit", () => {
    expect(rule(".ac-action-bar__buttons")).toContain("flex-direction: column");
    expect(rule(".ac-action-bar .ac-button")).toContain("width: 100%");
    expect(rule(".ac-action-bar .ac-button")).toContain("min-height: var(--ac-button-l)");
    expect(rule(".ac-action-bar__others")).toContain("grid-template-columns: minmax(0, 1fr)");
    // At least 136 a half: 2 × 136 + 8 fits a phone of 320 (288 wide), not a card on it.
    expect(rule(".ac-action-bar--others-2 .ac-action-bar__others")).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(min(100%, 136px), 1fr))",
    );
  });

  it("from 600 px: one row on the right, the main last, buttons by their text", () => {
    const wide = "(min-width: 600px)";
    expect(rule(".ac-action-bar__buttons", wide)).toContain("flex-direction: row-reverse");
    expect(rule(".ac-action-bar__buttons", wide)).toContain("justify-content: flex-start");
    expect(rule(".ac-action-bar .ac-button", wide)).toContain("width: auto");
  });

  it("pinned: clear of the raised center button, static from 1024", () => {
    expect(rule(".ac-action-bar--pinned")).toContain("var(--ac-center-tab-lift)");
    expect(rule(".ac-action-bar--pinned", "(min-width: 1024px)")).toContain("position: static");
  });
});
