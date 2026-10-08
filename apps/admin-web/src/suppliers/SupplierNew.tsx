import type {
  AdminSupplierLead,
  AdminSupplierLeadResponse,
  SupplierOnboardedResponse,
  SupplierType,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  IconButton,
  LoadingContent,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { goBack, navigateTo, supplierLeadPath, supplierPath, useLocation } from "../router";
import { useLoad } from "../use-load";
import { FormError, LoadError } from "../vehicles/shared";
import { CitySelect, SuppliersTabs, TypeSelect, useCities, useSupplierSaver } from "./shared";
import {
  binProblem,
  hiddenPhone,
  LEAD_STATUS_TEXT,
  mobilePhone,
  PHONE_HINT,
} from "./supplier-words";

/**
 * A-SUP-04 «Заведение поставщика» (SCREENS 7.4; TASK-036): from a request
 * with a signed contract — the form filled with its data (`?leadId=`) — or
 * by hand. «Создать и отправить приглашение» creates the company, its point,
 * the first employee and the invitation W-08 in one step on the server
 * (ARCHITECTURE 4.26 I251); then the supplier's card.
 */
export function SupplierNew() {
  const { query } = useLocation();
  const leadId = query.get("leadId");
  return leadId ? <FromLead key={leadId} leadId={leadId} /> : <OnboardForm lead={null} />;
}

function FromLead({ leadId }: { leadId: string }) {
  const card = useLoad<AdminSupplierLeadResponse>(
    () => apiClient.getSupplierLead({ leadId }),
    `onboard:${leadId}`,
  );
  const lead = card.data?.lead.lead;
  return (
    <>
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={lead !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {lead && <OnboardForm key={lead.id} lead={lead} onReload={card.reload} />}
      </LoadingContent>
    </>
  );
}

function OnboardForm({
  lead,
  onReload,
}: {
  lead: AdminSupplierLead | null;
  onReload?: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const cities = useCities();
  const saver = useSupplierSaver(lead ? "supplier_lead" : "supplier");
  const [form, setForm] = useState({
    name: lead?.companyName ?? "",
    bin: lead?.bin ?? "",
    cityId: lead?.city.id ?? "",
    type: (lead?.type ?? "goods") as SupplierType,
    address: "",
    district: "",
    contactPhone: "+7",
    memberName: lead?.contactName ?? "",
    memberPhone: "+7",
  });
  // From a request the first employee's number is the request's, hidden; another one may be typed.
  const [otherNumber, setOtherNumber] = useState(lead === null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const change = (patch: Partial<typeof form>) => {
    setForm((now) => ({ ...now, ...patch }));
    setProblems({});
  };
  const signed = lead === null || lead.status === "contract_signed";

  const submit = async () => {
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = "Укажите название компании";
    const bin = binProblem(form.bin);
    if (bin) found.bin = bin;
    if (!form.cityId) found.cityId = "Выберите город";
    if (!form.memberName.trim()) found.memberName = "Укажите имя сотрудника";
    const memberPhone = otherNumber ? mobilePhone(form.memberPhone) : null;
    if (otherNumber && !memberPhone) found.memberPhone = PHONE_HINT;
    const contactDigits = form.contactPhone.replace(/\D/g, "");
    const contactPhone = contactDigits.length > 1 ? mobilePhone(form.contactPhone) : null;
    if (contactDigits.length > 1 && !contactPhone) found.contactPhone = PHONE_HINT;
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    const common = {
      name: form.name.trim(),
      bin: form.bin.trim(),
      cityId: form.cityId,
      type: form.type,
      ...(form.address.trim() ? { address: form.address.trim() } : {}),
      ...(form.district.trim() ? { district: form.district.trim() } : {}),
      ...(contactPhone ? { contactPhone } : {}),
    };
    let created: SupplierOnboardedResponse | null = null;
    await saver.run(lead?.id ?? null, async () => {
      created = lead
        ? await apiClient.onboardSupplierLead(
            { leadId: lead.id },
            {
              expectedVersion: saver.versionOf(lead.version),
              ...common,
              contactName: form.memberName.trim(),
              firstMember: {
                name: form.memberName.trim(),
                ...(memberPhone ? { phone: memberPhone } : {}),
              },
            },
          )
        : await apiClient.createSupplier({
            ...common,
            contactName: form.memberName.trim(),
            firstMember: { name: form.memberName.trim(), phone: memberPhone! },
          });
    });
    if (created) {
      const answer: SupplierOnboardedResponse = created;
      const notes = [
        answer.firstMember.memberOfOtherSuppliers > 0
          ? `номер уже работает ещё в ${answer.firstMember.memberOfOtherSuppliers} компаниях — тот доступ сохраняется`
          : null,
        answer.firstMember.isAdministrator ? "номер — также администратор клуба" : null,
      ].filter(Boolean);
      toast.show(
        `Поставщик заведён. Приглашение отправлено в WhatsApp${notes.length ? ` (${notes.join("; ")})` : ""}`,
      );
      navigateTo(supplierPath(answer.supplier.id));
    }
  };

  const error = (field: string, server = field) => problems[field] ?? saver.fieldError(server);
  return (
    <>
      <div className="page__head page__head--back">
        <IconButton
          icon="arrowLeft"
          label="Назад"
          onClick={() => goBack(lead ? "supplierLeads" : "suppliers")}
        />
        <div className="cell-stack">
          <h1 className="ac-text-title-l page__title">Новый поставщик</h1>
          {lead && (
            <span className="ac-text-body-s ac-muted">
              Из заявки <AppLink href={supplierLeadPath(lead.id)}>{lead.companyName}</AppLink>
            </span>
          )}
        </div>
      </div>
      <SuppliersTabs active={null} />
      {!signed && lead && (
        <Banner tone="warning">
          Заявка на этапе «{LEAD_STATUS_TEXT[lead.status]}». Завести поставщика можно только из
          заявки «Договор подписан».
        </Banner>
      )}
      <div className="detail-stack form-page">
        <section className="card-section">
          <h2 className="ac-text-heading">Компания</h2>
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
            <TypeSelect
              value={form.type}
              onChange={(type) => change({ type: type as SupplierType })}
            />
          </div>
        </section>
        <section className="card-section">
          <h2 className="ac-text-heading">Точка выдачи</h2>
          <div className="form-grid">
            <TextField
              label="Адрес (улица, дом)"
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
              hint="Виден подписчикам до оформления"
            />
            {lead ? (
              <p className="ac-text-body-s ac-muted">
                Телефон компании — номер из заявки ({hiddenPhone(lead.phone)}); изменить можно в
                профиле поставщика.
              </p>
            ) : (
              <TextField
                label="Телефон компании (необязательно)"
                value={form.contactPhone}
                onChange={(contactPhone) => change({ contactPhone })}
                type="tel"
                inputMode="tel"
                error={error("contactPhone")}
              />
            )}
          </div>
        </section>
        <section className="card-section">
          <h2 className="ac-text-heading">Первый сотрудник</h2>
          <p className="ac-text-body-s ac-muted">
            Он станет контактным лицом и получит приглашение в кабинет в WhatsApp.
          </p>
          <div className="form-grid">
            <TextField
              label="Имя"
              value={form.memberName}
              onChange={(memberName) => change({ memberName })}
              maxLength={100}
              error={error("memberName", "firstMember.name")}
            />
            {otherNumber ? (
              <TextField
                label="Телефон (WhatsApp)"
                value={form.memberPhone}
                onChange={(memberPhone) => change({ memberPhone })}
                type="tel"
                inputMode="tel"
                error={error("memberPhone", "firstMember.phone")}
              />
            ) : (
              <div className="cell-stack">
                <span className="ac-text-caption ac-muted">Телефон (WhatsApp)</span>
                <span className="num">{lead ? hiddenPhone(lead.phone) : ""} — из заявки</span>
                <Button variant="text" size="s" onClick={() => setOtherNumber(true)}>
                  Указать другой номер
                </Button>
              </div>
            )}
          </div>
        </section>
        <FormError
          saver={saver}
          fields={[
            "name",
            "bin",
            "cityId",
            "contactPhone",
            "firstMember.name",
            "firstMember.phone",
          ]}
          onRefresh={onReload}
        />
        <div className="button-row">
          <Button disabled={!online || !signed} loading={saver.saving} onClick={submit}>
            Создать и отправить приглашение
          </Button>
          {!online && <span className="ac-text-caption ac-muted">Нужна сеть</span>}
        </div>
      </div>
    </>
  );
}
