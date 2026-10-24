import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateField } from "./DateField";
import {
  addMonths,
  maskAfterDelete,
  maskDateText,
  monthWeeks,
  moveDay,
  readDateText,
} from "./date-field-core";

afterEach(cleanup);

describe("the mask «ДД.ММ.ГГГГ»", () => {
  it("lays digits into the mask, the dots come by themselves", () => {
    expect(maskDateText("1")).toBe("1");
    expect(maskDateText("17")).toBe("17.");
    expect(maskDateText("171")).toBe("17.1");
    expect(maskDateText("1712")).toBe("17.12.");
    expect(maskDateText("17122026")).toBe("17.12.2026");
    expect(maskDateText("17.12.2026999")).toBe("17.12.2026");
    expect(maskDateText("17a/12-2026")).toBe("17.12.2026");
  });

  it("Backspace over an added dot takes the digit before it", () => {
    expect(maskAfterDelete("17.", "17")).toBe("1");
    expect(maskAfterDelete("17.12.", "17.12")).toBe("17.1");
    expect(maskAfterDelete("17.12.20", "17.12.2")).toBe("17.12.2");
  });

  it("reads the text: empty, unfinished, a day that doesn't exist, a date", () => {
    expect(readDateText("")).toEqual({ kind: "empty" });
    expect(readDateText("17.12.20")).toEqual({ kind: "partial" });
    expect(readDateText("31.02.2026")).toEqual({ kind: "invalid" });
    expect(readDateText("29.02.2027")).toEqual({ kind: "invalid" });
    expect(readDateText("00.12.2026")).toEqual({ kind: "invalid" });
    expect(readDateText("10.13.2026")).toEqual({ kind: "invalid" });
    expect(readDateText("29.02.2028")).toEqual({ kind: "date", iso: "2028-02-29" });
    expect(readDateText("16.12.2026")).toEqual({ kind: "date", iso: "2026-12-16" });
  });
});

describe("the calendar", () => {
  it("lays a month out Monday first", () => {
    // 1 December 2026 is a Tuesday.
    const weeks = monthWeeks(2026, 12);
    expect(weeks[0]).toEqual([
      null,
      "2026-12-01",
      "2026-12-02",
      "2026-12-03",
      "2026-12-04",
      "2026-12-05",
      "2026-12-06",
    ]);
    expect(weeks.at(-1)?.filter(Boolean).at(-1)).toBe("2026-12-31");
  });

  it("moves by the keys of a date picker", () => {
    expect(moveDay("2026-12-31", "ArrowRight")).toBe("2027-01-01");
    expect(moveDay("2026-12-01", "ArrowLeft")).toBe("2026-11-30");
    expect(moveDay("2026-12-16", "ArrowUp")).toBe("2026-12-09");
    expect(moveDay("2026-12-16", "ArrowDown")).toBe("2026-12-23");
    expect(moveDay("2026-12-16", "Home")).toBe("2026-12-14"); // Monday
    expect(moveDay("2026-12-16", "End")).toBe("2026-12-20"); // Sunday
    expect(moveDay("2026-12-16", "PageDown")).toBe("2027-01-16");
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
  });
});

describe("DateField", () => {
  it("masks what is typed and hands over the date once it is whole", () => {
    const onChange = vi.fn();
    render(<DateField label="Дата" value="" onChange={onChange} locale="ru" />);
    const input = screen.getByLabelText("Дата") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1612" } });
    expect(input.value).toBe("16.12.");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "16.12.2026" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-12-16");
  });

  it("says a day that doesn't exist and keeps what was typed", () => {
    const onChange = vi.fn();
    render(<DateField label="Дата" value="" onChange={onChange} locale="ru" />);
    const input = screen.getByLabelText("Дата") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "31022026" } });
    expect(input.value).toBe("31.02.2026");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Такой даты нет")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refuses a date before min with its own words", () => {
    const onChange = vi.fn();
    render(<DateField label="Дата" value="" onChange={onChange} locale="ru" min="2026-10-21" />);
    fireEvent.change(screen.getByLabelText("Дата"), { target: { value: "20.10.2026" } });
    expect(screen.getByText("Эта дата раньше допустимой")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens the calendar from the keyboard, walks it with arrows and chooses with Enter", () => {
    const onChange = vi.fn();
    render(
      <DateField
        label="Дата"
        value=""
        onChange={onChange}
        locale="ru"
        today="2026-10-21"
        min="2026-10-21"
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("Дата"), { key: "ArrowDown" });
    const grid = screen.getByRole("grid");
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("data-day")).toBe("2026-10-21");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).getAttribute("data-day")).toBe("2026-10-29");
    // A day before min can't be chosen.
    const past = grid.querySelector('[data-day="2026-10-20"]') as HTMLButtonElement;
    expect(past.disabled).toBe(true);
    fireEvent.click(document.activeElement as HTMLElement); // Enter on a button is a click
    expect(onChange).toHaveBeenLastCalledWith("2026-10-29");
    expect(screen.queryByRole("grid")).toBeNull();
    expect((screen.getByLabelText("Дата") as HTMLInputElement).value).toBe("29.10.2026");
  });

  it("Esc closes the calendar and returns to the field's button, nothing chosen", () => {
    const onChange = vi.fn();
    render(<DateField label="Дата" value="" onChange={onChange} locale="ru" today="2026-10-21" />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть календарь" }));
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Escape" });
    expect(screen.queryByRole("grid")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Открыть календарь");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("names the days for a screen reader and the month in the locale", () => {
    render(<DateField label="Күні" value="2026-12-16" onChange={() => undefined} locale="kk-KZ" />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть календарь" }));
    const chosen = document.querySelector('[data-day="2026-12-16"]') as HTMLElement;
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    expect(chosen.getAttribute("aria-label")).toMatch(/2026/);
  });
});
