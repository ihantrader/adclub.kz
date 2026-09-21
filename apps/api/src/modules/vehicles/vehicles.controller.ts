import { Controller, Headers, Inject, Param, Query, Res } from "@nestjs/common";
import {
  apiRoutes,
  CATALOG_CLIENT_CACHE_SECONDS,
  clientVehicleGenerationPathSchema,
  clientVehicleMakePathSchema,
  clientVehicleModelPathSchema,
  clientVehicleModificationsQuerySchema,
  type ClientVehicleGenerationPath,
  type ClientVehicleMakePath,
  type ClientVehicleModelPath,
  type ClientVehicleModificationsQuery,
  type VehicleGenerationsResponse,
  type VehicleMakesResponse,
  type VehicleModelsResponse,
  type VehicleModificationsResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Response } from "express";
import { ApiRoute } from "../../common/contract";
import { ZodValidationPipe } from "../../common/validation";
import { VehicleReadService } from "./vehicle-read.service";

/**
 * Answers depend on the language only, not on who asks: any client (a
 * guest too) and any proxy may keep one for a minute, as the catalog's
 * (ARCHITECTURE 4.15 I149). Errors are never cached (the error filter).
 */
function cacheable(response: Response, lang: string): void {
  response.setHeader("Cache-Control", `public, max-age=${CATALOG_CLIENT_CACHE_SECONDS}`);
  response.vary("Accept-Language");
  response.setHeader("Content-Language", lang);
}

/** Choosing a car step by step, for every client, guests included (M-GAR-03; ARCHITECTURE 4.24). */
@Controller()
export class VehiclesController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(VehicleReadService) private readonly vehicles: VehicleReadService) {}

  @ApiRoute(apiRoutes.getVehicleMakes)
  async makes(
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleMakesResponse> {
    const lang = pickLanguage(acceptLanguage);
    const result = await this.vehicles.makes(lang);
    cacheable(response, lang);
    return result;
  }

  @ApiRoute(apiRoutes.getVehicleMakeModels)
  async models(
    @Param(new ZodValidationPipe(clientVehicleMakePathSchema)) params: ClientVehicleMakePath,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleModelsResponse> {
    const lang = pickLanguage(acceptLanguage);
    const result = await this.vehicles.models(params.makeId, lang);
    cacheable(response, lang);
    return result;
  }

  @ApiRoute(apiRoutes.getVehicleModelGenerations)
  async generations(
    @Param(new ZodValidationPipe(clientVehicleModelPathSchema)) params: ClientVehicleModelPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleGenerationsResponse> {
    const lang = pickLanguage(acceptLanguage);
    const result = await this.vehicles.generations(params.modelId, lang);
    cacheable(response, lang);
    return result;
  }

  @ApiRoute(apiRoutes.getVehicleGenerationModifications)
  async modifications(
    @Param(new ZodValidationPipe(clientVehicleGenerationPathSchema))
    params: ClientVehicleGenerationPath,
    @Query(new ZodValidationPipe(clientVehicleModificationsQuerySchema))
    query: ClientVehicleModificationsQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleModificationsResponse> {
    const lang = pickLanguage(acceptLanguage);
    const result = await this.vehicles.modifications(params.generationId, lang, query.market);
    cacheable(response, lang);
    return result;
  }
}
