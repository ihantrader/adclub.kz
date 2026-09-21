import { Body, Controller, Headers, Inject, Param, Query } from "@nestjs/common";
import {
  apiRoutes,
  createOfferBodySchema,
  offerItemSearchQuerySchema,
  offerListQuerySchema,
  offerPathSchema,
  offerReceiptPreviewQuerySchema,
  offerStatusBodySchema,
  supplierOffersPathSchema,
  updateOfferBodySchema,
  type CreateOfferBody,
  type OfferItemSearchQuery,
  type OfferItemSearchResponse,
  type OfferListQuery,
  type OfferPage,
  type OfferPath,
  type OfferReceiptPreviewQuery,
  type OfferReceiptPreviewResponse,
  type OfferReturnedResponse,
  type OfferStatusBody,
  type SupplierOfferResponse,
  type SupplierOffersPath,
  type UpdateOfferBody,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { OfferItemSearch } from "./offer-item-search.service";
import { OffersService, type OfferActor } from "./offers.service";

function offerActor(session: AuthenticatedSession): OfferActor {
  if (!session.supplierId || !session.supplierMemberId) {
    throw new Error("A cabinet route reached without a company");
  }
  return {
    role: "supplier",
    accountId: session.accountId,
    supplierId: session.supplierId,
    memberId: session.supplierMemberId,
  };
}

/**
 * Offers in the cabinet (context `supplier`; SCREENS S-OFF-01…03). The
 * company is always the session's; another company's offer answers like
 * a missing one (404). Names come in the language of `Accept-Language`.
 */
@Controller()
export class OffersCabinetController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(OffersService) private readonly offers: OffersService,
    @Inject(OfferItemSearch) private readonly search: OfferItemSearch,
  ) {}

  @SessionRoute(apiRoutes.searchOfferItems)
  find(
    @Query(new ZodValidationPipe(offerItemSearchQuerySchema)) query: OfferItemSearchQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<OfferItemSearchResponse> {
    return this.search.search(offerActor(session), query, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.listSupplierOffers)
  list(
    @Query(new ZodValidationPipe(offerListQuerySchema)) query: OfferListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<OfferPage> {
    return this.offers.page(offerActor(session).supplierId, query, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.createSupplierOffer)
  async create(
    @Body(new ZodValidationPipe(createOfferBodySchema)) body: CreateOfferBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOfferResponse> {
    return {
      offer: await this.offers.create(body, offerActor(session), pickLanguage(acceptLanguage)),
    };
  }

  @SessionRoute(apiRoutes.previewOfferReceipt)
  async preview(
    @Query(new ZodValidationPipe(offerReceiptPreviewQuerySchema)) query: OfferReceiptPreviewQuery,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<OfferReceiptPreviewResponse> {
    return {
      receipt: await this.offers.previewReceipt(offerActor(session).supplierId, query.leadDays),
    };
  }

  @SessionRoute(apiRoutes.getSupplierOffer)
  async one(
    @Param(new ZodValidationPipe(offerPathSchema)) params: OfferPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOfferResponse> {
    return {
      offer: await this.offers.own(
        offerActor(session).supplierId,
        params.offerId,
        pickLanguage(acceptLanguage),
      ),
    };
  }

  @SessionRoute(apiRoutes.updateSupplierOffer)
  async update(
    @Param(new ZodValidationPipe(offerPathSchema)) params: OfferPath,
    @Body(new ZodValidationPipe(updateOfferBodySchema)) body: UpdateOfferBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOfferResponse> {
    return {
      offer: await this.offers.update(
        params.offerId,
        body,
        offerActor(session),
        pickLanguage(acceptLanguage),
      ),
    };
  }

  @SessionRoute(apiRoutes.withdrawSupplierOffer)
  async withdraw(
    @Param(new ZodValidationPipe(offerPathSchema)) params: OfferPath,
    @Body(new ZodValidationPipe(offerStatusBodySchema)) body: OfferStatusBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOfferResponse> {
    return {
      offer: await this.offers.withdraw(
        params.offerId,
        body.expectedVersion,
        offerActor(session),
        pickLanguage(acceptLanguage),
      ),
    };
  }

  @SessionRoute(apiRoutes.returnSupplierOffer)
  returnToSale(
    @Param(new ZodValidationPipe(offerPathSchema)) params: OfferPath,
    @Body(new ZodValidationPipe(offerStatusBodySchema)) body: OfferStatusBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<OfferReturnedResponse> {
    return this.offers.returnToSale(
      params.offerId,
      body.expectedVersion,
      offerActor(session),
      pickLanguage(acceptLanguage),
    );
  }
}

/** A supplier's offers for the administrator, read only (context `admin`; A-SUP-03). */
@Controller()
export class OffersAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(OffersService) private readonly offers: OffersService) {}

  @SessionRoute(apiRoutes.listAdminSupplierOffers)
  list(
    @Param(new ZodValidationPipe(supplierOffersPathSchema)) params: SupplierOffersPath,
    @Query(new ZodValidationPipe(offerListQuerySchema)) query: OfferListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<OfferPage> {
    return this.offers.adminPage(params.supplierId, query, pickLanguage(acceptLanguage));
  }
}
