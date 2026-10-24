import type { ClosedDatesTexts, DateFieldTexts, WeekHoursTexts } from "@adclub/ui";
import type { Translate } from "../i18n";

/** The words of the date field and its calendar, in the cabinet's language (TASK-079). */
export function dateFieldTexts(t: Translate): DateFieldTexts {
  return {
    placeholder: t("dateField.placeholder"),
    openCalendar: t("dateField.open"),
    previousMonth: t("dateField.previousMonth"),
    nextMonth: t("dateField.nextMonth"),
    invalid: t("dateField.invalid"),
    beforeMin: t("company.pastDate"),
    afterMax: t("dateField.afterMax"),
  };
}

/** The words of the shared hours editor. */
export function weekTexts(t: Translate): WeekHoursTexts {
  return {
    days: [t("day.1"), t("day.2"), t("day.3"), t("day.4"), t("day.5"), t("day.6"), t("day.7")],
    shortDays: [
      t("day.short.1"),
      t("day.short.2"),
      t("day.short.3"),
      t("day.short.4"),
      t("day.short.5"),
      t("day.short.6"),
      t("day.short.7"),
    ],
    dayMode: t("company.dayMode"),
    workDay: t("company.workDay"),
    dayOff: t("company.dayOff"),
    allDay: t("company.allDay"),
    customHours: t("company.customHours"),
    from: t("company.from"),
    to: t("company.to"),
    breakLabel: t("company.breakLabel"),
    removeBreak: t("company.removeBreak"),
    breakFrom: t("company.breakFrom"),
    breakTo: t("company.breakTo"),
    copyToWeekdays: t("company.copyToWeekdays"),
    intervalInvalid: t("company.intervalInvalid"),
  };
}

export function closedDatesTexts(t: Translate): ClosedDatesTexts {
  return {
    date: t("company.date"),
    note: t("company.note"),
    notePlaceholder: t("company.notePlaceholder"),
    addDate: t("company.addDate"),
    removeDate: t("company.removeDate"),
    empty: t("company.closedDatesEmpty"),
    pastDate: t("company.pastDate"),
    duplicateDate: t("company.duplicateDate"),
    dateRequired: t("company.dateRequired"),
    dateField: dateFieldTexts(t),
  };
}

/** The locale of dates and the calendar for an interface language. */
export function dateLocale(lang: string): string {
  return lang === "kk" ? "kk-KZ" : lang;
}
