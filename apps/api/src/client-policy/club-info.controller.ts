import { Controller, Inject } from "@nestjs/common";
import { apiRoutes, type ClubInfoResponse } from "@adclub/contracts";
import { ApiRoute } from "../common/contract";
import { AppSettings } from "../modules/settings";

const PHONE = /^\+7\d{10}$/;

/** A setting's value, or `null` when it is empty. */
function set(value: string): string | null {
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * `GET /meta/club-info` (TASK-077; ARCHITECTURE 4.73): «Документы и
 * поддержка» (M-PRO-06) and the address of «Стать партнёром клуба»
 * (S-PUB-01), from the settings `club_*` — read like the client policy,
 * through the settings cache (a change shows within 30 s), no HTTP cache.
 */
@Controller()
export class ClubInfoController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AppSettings) private readonly settings: AppSettings) {}

  @ApiRoute(apiRoutes.getClubInfo)
  async getClubInfo(): Promise<ClubInfoResponse> {
    const v = await this.settings.values();
    const contact = set(v.club_support_contact);
    return {
      termsUrl: set(v.club_terms_url),
      privacyUrl: set(v.club_privacy_url),
      supportPhone: contact !== null && PHONE.test(contact) ? contact : null,
      supportUrl: contact !== null && !PHONE.test(contact) ? contact : null,
      partnerFormUrl: set(v.club_partner_form_url),
    };
  }
}
