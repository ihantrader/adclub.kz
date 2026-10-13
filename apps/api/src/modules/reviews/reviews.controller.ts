import { Body, Controller, Headers, Inject, Param, Query, Res } from "@nestjs/common";
import {
  adminComplaintListQuerySchema,
  adminReviewActionBodySchema,
  adminReviewListQuerySchema,
  apiRoutes,
  complaintPathSchema,
  createComplaintBodySchema,
  createReviewBodySchema,
  editReviewTextBodySchema,
  hideReviewBodySchema,
  rejectReviewTextBodySchema,
  resolveComplaintBodySchema,
  reviewPathSchema,
  supplierPathSchema,
  supplierReviewsQuerySchema,
  takeComplaintBodySchema,
  type AdminComplaintListQuery,
  type AdminComplaintPage,
  type AdminComplaintResponse,
  type AdminReviewActionBody,
  type AdminReviewListQuery,
  type AdminReviewPage,
  type AdminReviewResponse,
  type ComplaintPath,
  type ComplaintResponse,
  type CreateComplaintBody,
  type CreateReviewBody,
  type EditReviewTextBody,
  type HideReviewBody,
  type RejectReviewTextBody,
  type ResolveComplaintBody,
  type ReviewPath,
  type ReviewResponse,
  type SupplierPath,
  type SupplierReviewsQuery,
  type SupplierReviewsResponse,
  type TakeComplaintBody,
  type UserReviewResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Response } from "express";
import { ZodValidationPipe } from "../../common/validation";
import { RateLimitedRoute } from "../../rate-limit";
import { ClubAccess } from "../club-access";
import {
  CurrentSession,
  OptionalSession,
  SessionRoute,
  type AuthenticatedSession,
} from "../identity";
import { roleSafeCaching, viewerOf } from "../showcase";
import { ComplaintsService } from "./complaints.service";
import { ReviewsService, type ReviewAdmin } from "./reviews.service";

/** The administrator a session of the `admin` context belongs to (the access rule set it). */
function adminOf(session: AuthenticatedSession): ReviewAdmin {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { adminId: session.adminUserId, accountId: session.accountId };
}

/**
 * The user's reviews and complaints (context `user`, the mobile app; SCREENS
 * M-ORD-05, M-ORD-06). Another user's order or review answers like a missing
 * one (404).
 */
@Controller()
export class UserReviewsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(ComplaintsService) private readonly complaints: ComplaintsService,
  ) {}

  @RateLimitedRoute(apiRoutes.createReview)
  create(
    @Body(new ZodValidationPipe(createReviewBodySchema)) body: CreateReviewBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ReviewResponse> {
    return this.reviews.create(session.accountId, body);
  }

  @SessionRoute(apiRoutes.editReviewText)
  async editText(
    @Param(new ZodValidationPipe(reviewPathSchema)) params: ReviewPath,
    @Body(new ZodValidationPipe(editReviewTextBodySchema)) body: EditReviewTextBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserReviewResponse> {
    return { review: await this.reviews.editText(session.accountId, params.reviewId, body.text) };
  }

  @SessionRoute(apiRoutes.publishReviewScoreOnly)
  async scoreOnly(
    @Param(new ZodValidationPipe(reviewPathSchema)) params: ReviewPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserReviewResponse> {
    return { review: await this.reviews.publishScoreOnly(session.accountId, params.reviewId) };
  }

  @RateLimitedRoute(apiRoutes.createComplaint)
  complain(
    @Body(new ZodValidationPipe(createComplaintBodySchema)) body: CreateComplaintBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ComplaintResponse> {
    return this.complaints.create(session.accountId, body);
  }
}

/**
 * The supplier's page with its published reviews (M-CAT-09), guests too —
 * limited and cached as the catalog, by the rule of the showcase.
 */
@Controller()
export class SupplierReviewsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(ClubAccess) private readonly clubAccess: ClubAccess,
  ) {}

  @RateLimitedRoute(apiRoutes.getSupplierReviews)
  async list(
    @Param(new ZodValidationPipe(supplierPathSchema)) params: SupplierPath,
    @Query(new ZodValidationPipe(supplierReviewsQuerySchema)) query: SupplierReviewsQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @OptionalSession() session: AuthenticatedSession | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SupplierReviewsResponse> {
    const viewer = await viewerOf(session, this.clubAccess);
    const answer = await this.reviews.publicPage(params.supplierId, query, viewer);
    roleSafeCaching(response, pickLanguage(acceptLanguage), session !== null);
    return answer;
  }
}

/** Reviews and complaints for the administrator (context `admin`; SCREENS A-REV-01, A-REV-02). */
@Controller()
export class AdminReviewsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(ComplaintsService) private readonly complaints: ComplaintsService,
  ) {}

  @SessionRoute(apiRoutes.listAdminReviews)
  list(
    @Query(new ZodValidationPipe(adminReviewListQuerySchema)) query: AdminReviewListQuery,
  ): Promise<AdminReviewPage> {
    return this.reviews.adminPage(query);
  }

  @SessionRoute(apiRoutes.publishAdminReview)
  async publish(
    @Param(new ZodValidationPipe(reviewPathSchema)) params: ReviewPath,
    @Body(new ZodValidationPipe(adminReviewActionBodySchema)) body: AdminReviewActionBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminReviewResponse> {
    return {
      review: await this.reviews.decide(
        params.reviewId,
        body.expectedVersion,
        { action: "publish" },
        adminOf(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.rejectAdminReviewText)
  async rejectText(
    @Param(new ZodValidationPipe(reviewPathSchema)) params: ReviewPath,
    @Body(new ZodValidationPipe(rejectReviewTextBodySchema)) body: RejectReviewTextBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminReviewResponse> {
    return {
      review: await this.reviews.decide(
        params.reviewId,
        body.expectedVersion,
        { action: "reject_text", reason: body.reason },
        adminOf(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.hideAdminReview)
  async hide(
    @Param(new ZodValidationPipe(reviewPathSchema)) params: ReviewPath,
    @Body(new ZodValidationPipe(hideReviewBodySchema)) body: HideReviewBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminReviewResponse> {
    return {
      review: await this.reviews.decide(
        params.reviewId,
        body.expectedVersion,
        { action: "hide", reason: body.reason },
        adminOf(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.restoreAdminReview)
  async restore(
    @Param(new ZodValidationPipe(reviewPathSchema)) params: ReviewPath,
    @Body(new ZodValidationPipe(adminReviewActionBodySchema)) body: AdminReviewActionBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminReviewResponse> {
    return {
      review: await this.reviews.decide(
        params.reviewId,
        body.expectedVersion,
        { action: "restore" },
        adminOf(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.listAdminComplaints)
  complaintList(
    @Query(new ZodValidationPipe(adminComplaintListQuerySchema)) query: AdminComplaintListQuery,
  ): Promise<AdminComplaintPage> {
    return this.complaints.adminPage(query);
  }

  @SessionRoute(apiRoutes.getAdminComplaint)
  async complaint(
    @Param(new ZodValidationPipe(complaintPathSchema)) params: ComplaintPath,
  ): Promise<AdminComplaintResponse> {
    return { complaint: await this.complaints.adminOne(params.complaintId) };
  }

  @SessionRoute(apiRoutes.takeAdminComplaint)
  async take(
    @Param(new ZodValidationPipe(complaintPathSchema)) params: ComplaintPath,
    @Body(new ZodValidationPipe(takeComplaintBodySchema)) body: TakeComplaintBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminComplaintResponse> {
    return {
      complaint: await this.complaints.decide(
        params.complaintId,
        body.expectedVersion,
        { action: "take" },
        adminOf(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.resolveAdminComplaint)
  async resolve(
    @Param(new ZodValidationPipe(complaintPathSchema)) params: ComplaintPath,
    @Body(new ZodValidationPipe(resolveComplaintBodySchema)) body: ResolveComplaintBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminComplaintResponse> {
    return {
      complaint: await this.complaints.decide(
        params.complaintId,
        body.expectedVersion,
        { action: "resolve", comment: body.comment },
        adminOf(session),
      ),
    };
  }
}
