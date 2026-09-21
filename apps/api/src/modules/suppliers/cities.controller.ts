import { Body, Controller, Headers, Inject, Param, Res } from "@nestjs/common";
import {
  apiRoutes,
  CATALOG_CLIENT_CACHE_SECONDS,
  cityIdPathSchema,
  createCityBodySchema,
  reorderCitiesBodySchema,
  setCityStatusBodySchema,
  updateCityBodySchema,
  type AdminCityListResponse,
  type AdminCityResponse,
  type CityIdPath,
  type CityListResponse,
  type CreateCityBody,
  type ReorderCitiesBody,
  type SetCityStatusBody,
  type UpdateCityBody,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Response } from "express";
import { ApiRoute } from "../../common/contract";
import { ZodValidationPipe } from "../../common/validation";
import { adminActor } from "../catalog";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { CitiesService } from "./cities.service";

/**
 * The directory of cities: for clients (guests included, cacheable for a
 * minute like the catalog — ARCHITECTURE 4.15 I149) and for the
 * administrator (context `admin`).
 */
@Controller()
export class CitiesController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CitiesService) private readonly cities: CitiesService) {}

  @ApiRoute(apiRoutes.getCities)
  async list(
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CityListResponse> {
    const lang = pickLanguage(acceptLanguage);
    const result = await this.cities.listForClients(lang);
    response.setHeader("Cache-Control", `public, max-age=${CATALOG_CLIENT_CACHE_SECONDS}`);
    response.vary("Accept-Language");
    response.setHeader("Content-Language", lang);
    return result;
  }

  @SessionRoute(apiRoutes.listAdminCities)
  async listAdmin(): Promise<AdminCityListResponse> {
    return { cities: await this.cities.listAdmin() };
  }

  @SessionRoute(apiRoutes.createCity)
  async create(
    @Body(new ZodValidationPipe(createCityBodySchema)) body: CreateCityBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCityResponse> {
    return { city: await this.cities.create(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.updateCity)
  async update(
    @Param(new ZodValidationPipe(cityIdPathSchema)) params: CityIdPath,
    @Body(new ZodValidationPipe(updateCityBodySchema)) body: UpdateCityBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCityResponse> {
    return { city: await this.cities.update(params.cityId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.setCityStatus)
  async setStatus(
    @Param(new ZodValidationPipe(cityIdPathSchema)) params: CityIdPath,
    @Body(new ZodValidationPipe(setCityStatusBodySchema)) body: SetCityStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCityResponse> {
    return {
      city: await this.cities.setStatus(
        params.cityId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.reorderCities)
  async reorder(
    @Body(new ZodValidationPipe(reorderCitiesBodySchema)) body: ReorderCitiesBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCityListResponse> {
    return { cities: await this.cities.reorder(body.cityIds, adminActor(session)) };
  }
}
