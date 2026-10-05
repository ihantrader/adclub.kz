import type { SupplierMembershipListResponse } from "@adclub/contracts";
import { Banner, Button, Dialog, Icon, useToast } from "@adclub/ui";
import { useState } from "react";
import { switchCompany } from "../cabinet/cabinet-store";
import { useOnline } from "../connection";
import { saveErrorText } from "../errors";
import { useT } from "../i18n";
import { ChoiceButton } from "./SignIn";

type Companies = SupplierMembershipListResponse["suppliers"];

/** The companies of the employee with the current one marked (S-AUTH-03, S-TEAM-02). */
export function CompanyChoices({
  companies,
  onDone,
}: {
  companies: Companies;
  onDone?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="stack-s">
      {error && <Banner tone="danger">{error}</Banner>}
      <ul className="choice-list">
        {companies.map((company) => (
          <li key={company.id}>
            <ChoiceButton
              current={company.current}
              onClick={async () => {
                if (company.current || !online) return;
                setError(null);
                try {
                  await switchCompany(company.id);
                  toast.show(t("settings.companySwitched", { name: company.name }));
                  onDone?.();
                } catch (thrown) {
                  setError(saveErrorText(thrown, t));
                }
              }}
            >
              <span className="choice-list__text">
                <span className="ac-text-body-strong">{company.name}</span>
                <span className="ac-text-body-s ac-muted">{company.city}</span>
              </span>
              {company.current ? (
                <span className="choice-list__current ac-text-caption-strong">
                  <Icon name="check" size={16} />
                  {t("settings.current")}
                </span>
              ) : (
                <Icon name="chevronRight" size={20} />
              )}
            </ChoiceButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CompanySwitchDialog({
  open,
  onClose,
  companies,
}: {
  open: boolean;
  onClose: () => void;
  companies: Companies;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("settings.switchCompany")}
      actions={
        <Button variant="secondary" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      <CompanyChoices companies={companies} onDone={onClose} />
    </Dialog>
  );
}
