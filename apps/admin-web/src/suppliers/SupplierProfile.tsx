import type { AdminSupplierCard, SupplierType, UpdateSupplierBody } from "@adclub/contracts";
import {
  Banner,
  Button,
  ClosedDatesEditor,
  Switch,
  TextField,
  todayIn,
  upcomingClosedDates,
  useToast,
  WeekHoursEditor,
  weekFormOf,
  weeklyHoursOf,
  type ClosedDatesTexts,
  type DayForm,
  type ScheduleClosedDate,
  type WeekForm,
  type WeekHoursTexts,
} from "@adclub/ui";
import { formatPhone, useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { FormError } from "../vehicles/shared";
import { CitySelect, TypeSelect, useCities, useSupplierSaver } from "./shared";
import { binProblem, mobilePhone, PHONE_HINT } from "./supplier-words";

/** The hours editor's words (the cabinet gives the same in kk/ru/en). */
const WEEK_TEXTS: WeekHoursTexts = {
  days: ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"],
  dayMode: "режим дня",
  workDay: "Рабочий",
  dayOff: "Выходной",
  allDay: "Круглосуточно",
  customHours: "Особый график",
  from: "С",
  to: "До",
  withBreak: "С перерывом",
  breakFrom: "Перерыв с",
  breakTo: "Перерыв до",
  intervalInvalid: "Проверьте время: конец позже начала, перерыв внутри рабочего дня",
};

const CLOSED_TEXTS: ClosedDatesTexts = {
  date: "Дата",
  note: "Заметка",
  notePlaceholder: "Например, «День Независимости»",
  addDate: "Добавить дату",
  removeDate: "Убрать дату",
  empty: "Нерабочих дат нет",
  pastDate: "Дата уже прошла",
  duplicateDate: "Эта дата уже в списке",
};

interface Props {
  card: AdminSupplierCard;
  onChanged: (card: AdminSupplierCard) => void;
  onReload: () => void;
}

/**
 * «Профиль» of A-SUP-03 (TASK-036): the company's data with its version
 * (only what the administrator changed is sent — a colleague's change of
 * another field stays), and the hours and days off with the very form of
 * the cabinet (`@adclub/ui`). D-060: without hours the showcase shows
 * none of the supplier's offers.
 */
export function SupplierProfile({ card, onChanged, onReload }: Props) {
  return (
    <div className="detail-stack form-page">
      <ProfileForm card={card} onChanged={onChanged} onReload={onReload} />
      <ScheduleForm card={card} onChanged={onChanged} onReload={onReload} />
    </div>
  );
}

function phoneText(phone: string | null): string {
  return phone ? formatPhone(phone) : "+7";
}

function ProfileForm({ card, onChanged, onReload }: Props) {
  const toast = useToast();
  const online = useOnline();
  const cities = useCities();
  const saver = useSupplierSaver("supplier");
  // What the form was opened with: only the fields changed from it are sent.
  const [base] = useState(card);
  const [form, setForm] = useState({
    name: card.name,
    bin: card.bin ?? "",
    cityId: card.city.id,
    type: card.type as SupplierType,
    address: card.location.address ?? "",
    district: card.location.district ?? "",
    contactName: card.contactName ?? "",
    contactPhone: phoneText(card.contactPhone),
    deliveryByDefault: card.deliveryByDefault,
  });
  const [problems, setProblems] = useState<Record<string, string>>({});
  const change = (patch: Partial<typeof form>) => {
    setForm((now) => ({ ...now, ...patch }));
    setProblems({});
  };

  const save = async () => {
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = "Укажите название";
    if (form.bin.trim() || base.bin) {
      const bin = binProblem(form.bin);
      if (bin) found.bin = bin;
    }
    const digits = form.contactPhone.replace(/\D/g, "");
    const phone = digits.length > 1 ? mobilePhone(form.contactPhone) : null;
    if (digits.length > 1 && !phone) found.contactPhone = PHONE_HINT;
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    const optional = (text: string) => text.trim() || null;
    const body: Omit<UpdateSupplierBody, "expectedVersion"> = {};
    if (form.name.trim() !== base.name) body.name = form.name.trim();
    if (form.bin.trim() && form.bin.trim() !== (base.bin ?? "")) body.bin = form.bin.trim();
    if (form.cityId !== base.city.id) body.cityId = form.cityId;
    if (form.type !== base.type) body.type = form.type;
    if (optional(form.address) !== base.location.address) body.address = optional(form.address);
    if (optional(form.district) !== base.location.district) {
      body.district = optional(form.district);
    }
    if (optional(form.contactName) !== base.contactName) {
      body.contactName = optional(form.contactName);
    }
    if (phone !== base.contactPhone) body.contactPhone = phone;
    if (form.deliveryByDefault !== base.deliveryByDefault) {
      body.deliveryByDefault = form.deliveryByDefault;
    }
    if (Object.keys(body).length === 0) {
      toast.show("Изменений нет");
      return;
    }
    let next: AdminSupplierCard | null = null;
    const done = await saver.run(card.id, async () => {
      next = (
        await apiClient.updateSupplier(
          { supplierId: card.id },
          { expectedVersion: saver.versionOf(card.version), ...body },
        )
      ).supplier;
    });
    if (done && next) {
      saver.reset();
      onChanged(next);
      toast.show("Сохранено");
    }
  };

  const error = (field: string) => problems[field] ?? saver.fieldError(field);
  return (
    <section className="card-section">
      <h2 className="ac-text-heading">Компания и точка выдачи</h2>
      <div className="form-grid">
        <TextField
          label="Название"
          value={form.name}
          onChange={(name) => change({ name })}
          maxLength={200}
          error={error("name")}
        />
        <TextField
          label="БИН"
          value={form.bin}
          onChange={(bin) => change({ bin })}
          inputMode="numeric"
          maxLength={32}
          error={error("bin")}
        />
        <CitySelect
          value={form.cityId}
          onChange={(cityId) => change({ cityId })}
          cities={cities}
          error={error("cityId")}
        />
        <TypeSelect value={form.type} onChange={(type) => change({ type: type as SupplierType })} />
        <TextField
          label="Адрес точки выдачи"
          value={form.address}
          onChange={(address) => change({ address })}
          maxLength={300}
          hint="Покупатель увидит его после того, как поставщик примет заявку"
        />
        <TextField
          label="Район"
          value={form.district}
          onChange={(district) => change({ district })}
          maxLength={100}
        />
        <TextField
          label="Контактное лицо"
          value={form.contactName}
          onChange={(contactName) => change({ contactName })}
          maxLength={100}
        />
        <TextField
          label="Телефон компании"
          value={form.contactPhone}
          onChange={(contactPhone) => change({ contactPhone })}
          type="tel"
          inputMode="tel"
          error={error("contactPhone")}
          hint="Покупатель увидит его после принятия заявки"
        />
      </div>
      <Switch
        label="Доставка по умолчанию для новых предложений"
        description="Только начальное значение «Доставки» в форме нового предложения; выставленные предложения не меняются"
        checked={form.deliveryByDefault}
        onChange={(deliveryByDefault) => change({ deliveryByDefault })}
      />
      <FormError
        saver={saver}
        fields={["name", "bin", "cityId", "contactPhone"]}
        onRefresh={onReload}
      />
      <div className="button-row">
        <Button disabled={!online} loading={saver.saving} onClick={save}>
          Сохранить
        </Button>
      </div>
    </section>
  );
}

function ScheduleForm({ card, onChanged, onReload }: Props) {
  const toast = useToast();
  const online = useOnline();
  const saver = useSupplierSaver("supplier");
  const today = todayIn(card.timeZone);
  const [week, setWeek] = useState<WeekForm>(() => weekFormOf(card.schedule.weeklyHours));
  const [dates, setDates] = useState<ScheduleClosedDate[]>(() =>
    upcomingClosedDates(card.schedule.closedDates, today),
  );
  const [invalidDays, setInvalidDays] = useState<number[]>([]);
  const [noWorkingDay, setNoWorkingDay] = useState(false);

  const setDay = (day: number, change: Partial<DayForm>) => {
    setWeek((current) => current.map((item) => (item.day === day ? { ...item, ...change } : item)));
    setInvalidDays((current) => current.filter((item) => item !== day));
    setNoWorkingDay(false);
  };

  const save = async () => {
    const result = weeklyHoursOf(week);
    if (!result.ok) {
      setInvalidDays(result.invalidDays);
      setNoWorkingDay(result.noWorkingDay);
      return;
    }
    let next: AdminSupplierCard | null = null;
    const done = await saver.run(card.id, async () => {
      next = (
        await apiClient.setAdminSupplierSchedule(
          { supplierId: card.id },
          {
            expectedVersion: saver.versionOf(card.version),
            weeklyHours: result.weeklyHours,
            closedDates: upcomingClosedDates(dates, todayIn(card.timeZone)),
          },
        )
      ).supplier;
    });
    if (done && next) {
      saver.reset();
      onChanged(next);
      toast.show("Часы работы сохранены");
    }
  };

  return (
    <section className="card-section">
      <h2 className="ac-text-heading">Часы работы</h2>
      {card.schedule.weeklyHours === null ? (
        <Banner tone="warning">
          Часы работы не заданы. Без часов работы предложения не показываются клиентам.
        </Banner>
      ) : (
        <p className="ac-text-body-s ac-muted">
          Без часов работы предложения не показываются клиентам. Время — часовой пояс точки (
          {card.timeZone}).
        </p>
      )}
      <WeekHoursEditor
        week={week}
        invalidDays={invalidDays}
        onDayChange={setDay}
        texts={WEEK_TEXTS}
      />
      {noWorkingDay && (
        <Banner tone="danger">
          Нужен хотя бы один рабочий день — без него предложения не показываются клиентам.
        </Banner>
      )}
      <h2 className="ac-text-heading">Нерабочие даты</h2>
      <p className="ac-text-body-s ac-muted">
        Праздники и выходные точки: в эти дни заявки не принимаются и не выдаются.
      </p>
      <ClosedDatesEditor
        dates={dates}
        today={today}
        onChange={setDates}
        texts={CLOSED_TEXTS}
        locale="ru"
      />
      <FormError saver={saver} onRefresh={onReload} />
      <div className="button-row">
        <Button disabled={!online} loading={saver.saving} onClick={save}>
          Сохранить часы и даты
        </Button>
      </div>
    </section>
  );
}
