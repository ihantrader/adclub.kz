import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "./Select";
import { moveHighlight, typeahead, type SelectChoice } from "./select-core";

afterEach(cleanup);

const CITIES: SelectChoice[] = [
  { value: "almaty", label: "Алматы" },
  { value: "astana", label: "Астана" },
  { value: "aktobe", label: "Актобе", disabled: true },
  { value: "karaganda", label: "Караганда" },
  { value: "kostanay", label: "Костанай" },
];

function Field({ onChange = vi.fn(), disabled = false, initial = "" }) {
  const [value, setValue] = useState(initial);
  return (
    <Select
      label="Город"
      value={value}
      placeholder="Выберите город"
      options={CITIES}
      disabled={disabled}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const combo = () => screen.getByRole("combobox");
const key = (name: string, extra: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(combo(), { key: name, ...extra });

describe("select-core", () => {
  it("skips disabled options and stops at the ends", () => {
    expect(moveHighlight(CITIES, 1, "next")).toBe(3);
    expect(moveHighlight(CITIES, 3, "previous")).toBe(1);
    expect(moveHighlight(CITIES, 4, "next")).toBe(4);
    expect(moveHighlight(CITIES, -1, "last")).toBe(4);
    expect(moveHighlight(CITIES, 0, "pageDown")).toBe(4);
  });

  it("finds by the first letters and goes round the options of one letter", () => {
    expect(typeahead(CITIES, -1, "к")).toBe(3);
    expect(typeahead(CITIES, 3, "к")).toBe(4);
    expect(typeahead(CITIES, 4, "к")).toBe(3);
    expect(typeahead(CITIES, -1, "кос")).toBe(4);
    expect(typeahead(CITIES, 0, "аст")).toBe(1);
    // A disabled option is never found.
    expect(typeahead(CITIES, 1, "акт")).toBe(-1);
    expect(typeahead(CITIES, 0, "ш")).toBe(-1);
  });
});

describe("Select", () => {
  it("is named by its label and shows the placeholder until a choice", () => {
    render(<Field />);
    expect(combo().getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("Город").id).toBe(combo().getAttribute("aria-labelledby"));
    expect(combo().textContent).toContain("Выберите город");
    expect(combo().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("select")).toBeNull();
  });

  it("opens with ↓, moves past a disabled option, chooses with Enter", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} initial="astana" />);
    key("ArrowDown");
    expect(combo().getAttribute("aria-expanded")).toBe("true");
    const active = () =>
      document.getElementById(combo().getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(active()).toBe("Астана");
    key("ArrowDown");
    expect(active()).toBe("Караганда");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith("karaganda");
    expect(combo().getAttribute("aria-expanded")).toBe("false");
    expect(combo().textContent).toContain("Караганда");
  });

  it("closes with Esc without choosing, and Esc does not reach a dialog around it", () => {
    const onChange = vi.fn();
    const onDialogKey = vi.fn();
    render(
      <div onKeyDown={onDialogKey}>
        <Field onChange={onChange} />
      </div>,
    );
    key(" ");
    key("ArrowDown");
    key("Escape");
    expect(combo().getAttribute("aria-expanded")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
    expect(onDialogKey.mock.calls.some(([event]) => event.key === "Escape")).toBe(false);
  });

  it("finds an option by its first letter, closed and open", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    key("к");
    expect(combo().getAttribute("aria-expanded")).toBe("true");
    const active = () =>
      document.getElementById(combo().getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(active()).toBe("Караганда");
    key("к");
    expect(active()).toBe("Костанай");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith("kostanay");
  });

  it("Home and End go to the first and the last enabled option; Tab chooses", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    key("End");
    expect(screen.getByRole("listbox")).toBeTruthy();
    key("Home");
    key("Tab");
    expect(onChange).toHaveBeenCalledWith("almaty");
  });

  it("a click on an option chooses it; a disabled option cannot be chosen", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    fireEvent.click(combo());
    fireEvent.click(screen.getByRole("option", { name: "Актобе" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Актобе" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("option", { name: "Астана" }));
    expect(onChange).toHaveBeenCalledWith("astana");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("marks the chosen option", () => {
    render(<Field initial="karaganda" />);
    fireEvent.click(combo());
    expect(screen.getByRole("option", { name: "Караганда" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("a disabled select does not open and is out of the Tab order", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} disabled />);
    expect(combo().tabIndex).toBe(-1);
    expect(combo().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(combo());
    key("ArrowDown");
    key("к");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("compact is the 40 field of filters", () => {
    render(<Select label="Тип" value="" options={CITIES} onChange={() => undefined} compact />);
    expect(combo().closest(".ac-field")?.classList.contains("ac-field--compact")).toBe(true);
  });
});
