import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { WeekHoursEditor, type WeekHoursTexts } from "./schedule";
import {
  copyToWeekdays,
  dayHoursText,
  weekFormOf,
  weeklyHoursOf,
  type DayForm,
  type WeekForm,
} from "./schedule-form";

afterEach(cleanup);

const texts: WeekHoursTexts = {
  days: ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"],
  shortDays: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
  dayMode: "режим",
  workDay: "Рабочий",
  dayOff: "Выходной",
  allDay: "Круглосуточно",
  customHours: "Особые часы",
  from: "с",
  to: "до",
  breakLabel: "Перерыв",
  removeBreak: "убрать перерыв",
  breakFrom: "перерыв с",
  breakTo: "перерыв до",
  copyToWeekdays: "Скопировать понедельник на будни",
  intervalInvalid: "Проверьте время",
};

function Editor({ initial }: { initial: WeekForm }) {
  const [week, setWeek] = useState(initial);
  const result = weeklyHoursOf(week);
  return (
    <>
      <WeekHoursEditor
        week={week}
        invalidDays={result.ok ? [] : result.invalidDays}
        texts={texts}
        onDayChange={(day, change) =>
          setWeek((current) =>
            current.map((item) => (item.day === day ? { ...item, ...change } : item)),
          )
        }
      />
      <output data-testid="result">{JSON.stringify(result)}</output>
    </>
  );
}

const result = () => JSON.parse(screen.getByTestId("result").textContent ?? "{}");

describe("copyToWeekdays", () => {
  it("gives Monday's hours and break to Tuesday … Friday, the weekend keeps its own", () => {
    const week = weekFormOf(null).map((day): DayForm =>
      day.day === 1 ? { ...day, from: "10:00", to: "19:00", withBreak: true } : day,
    );
    const changes = copyToWeekdays(week);
    expect(changes.map((change) => change.day)).toEqual([2, 3, 4, 5]);
    expect(changes[0]?.change).toMatchObject({
      mode: "hours",
      from: "10:00",
      to: "19:00",
      withBreak: true,
      breakFrom: "13:00",
      breakTo: "14:00",
    });
  });

  it("says a folded day as its intervals", () => {
    const [monday] = weekFormOf([
      {
        day: 1,
        intervals: [
          { from: "09:00", to: "13:00" },
          { from: "14:00", to: "18:00" },
        ],
      },
    ]);
    expect(dayHoursText(monday!)).toBe("09:00–13:00, 14:00–18:00");
  });
});

describe("WeekHoursEditor", () => {
  it("shows seven rows with short names and copies Monday to the weekdays", () => {
    render(<Editor initial={weekFormOf(null)} />);
    expect(document.querySelectorAll(".ac-week__day")).toHaveLength(7);
    fireEvent.change(screen.getByLabelText("Понедельник: с"), { target: { value: "10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Скопировать понедельник на будни" }));
    const days = result().weeklyHours as { day: number; intervals: { from: string }[] }[];
    expect(days.filter((d) => d.day <= 5).map((d) => d.intervals[0]?.from)).toEqual([
      "10:00",
      "10:00",
      "10:00",
      "10:00",
      "10:00",
    ]);
    expect(days.find((d) => d.day === 6)?.intervals).toEqual([]);
  });

  it("adds a break with «+ Перерыв» and removes it", () => {
    render(<Editor initial={weekFormOf(null)} />);
    fireEvent.click(screen.getByRole("button", { name: "Вторник: Перерыв" }));
    expect(screen.getByLabelText("Вторник: перерыв с")).toBeTruthy();
    expect(result().weeklyHours[1].intervals).toEqual([
      { from: "09:00", to: "13:00" },
      { from: "14:00", to: "18:00" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Вторник: убрать перерыв" }));
    expect(result().weeklyHours[1].intervals).toEqual([{ from: "09:00", to: "18:00" }]);
  });

  it("turns a day round the clock and back to a day off", () => {
    render(<Editor initial={weekFormOf(null)} />);
    const mode = screen.getByLabelText("Среда: режим");
    fireEvent.change(mode, { target: { value: "allDay" } });
    expect(result().weeklyHours[2].intervals).toEqual([{ from: "00:00", to: "24:00" }]);
    expect(screen.queryByLabelText("Среда: с")).toBeNull();
    fireEvent.change(mode, { target: { value: "off" } });
    expect(result().weeklyHours[2].intervals).toEqual([]);
  });

  it("says a break that leaves the hours, or an end before the start, in the row itself", () => {
    render(<Editor initial={weekFormOf(null)} />);
    fireEvent.click(screen.getByRole("button", { name: "Четверг: Перерыв" }));
    fireEvent.change(screen.getByLabelText("Четверг: перерыв до"), { target: { value: "19:00" } });
    expect(result()).toMatchObject({ ok: false, invalidDays: [4] });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Проверьте время");
    expect(screen.getByLabelText("Четверг: с").getAttribute("aria-invalid")).toBe("true");
    // The folded row of an invalid day stays open on a phone.
    expect(alert.closest(".ac-week__day")?.classList.contains("ac-week__day--open")).toBe(true);
    fireEvent.change(screen.getByLabelText("Четверг: перерыв до"), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText("Пятница: до"), { target: { value: "08:00" } });
    expect(result()).toMatchObject({ ok: false, invalidDays: [5] });
  });

  it("folds a row on a phone into its summary and opens it on a press", () => {
    render(<Editor initial={weekFormOf(null)} />);
    // The short «Сб» on screen, the whole «Суббота» for a screen reader.
    const saturday = screen.getByRole("button", { name: /Суббота/ });
    expect(saturday.textContent).toContain("Сб");
    expect(saturday.getAttribute("aria-expanded")).toBe("false");
    expect(saturday.textContent).toContain("Выходной");
    fireEvent.click(saturday);
    expect(saturday.getAttribute("aria-expanded")).toBe("true");
  });
});
