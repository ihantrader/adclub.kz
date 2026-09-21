import { Body, Controller, Inject, Param, Query } from "@nestjs/common";
import {
  apiRoutes,
  createVehicleEngineBodySchema,
  createVehicleGenerationBodySchema,
  createVehicleMakeBodySchema,
  createVehicleModelBodySchema,
  createVehicleModificationBodySchema,
  createVehicleOptionBodySchema,
  setVehicleStatusBodySchema,
  updateVehicleEngineBodySchema,
  updateVehicleGenerationBodySchema,
  updateVehicleMakeBodySchema,
  updateVehicleModelBodySchema,
  updateVehicleModificationBodySchema,
  updateVehicleOptionBodySchema,
  vehicleEngineIdPathSchema,
  vehicleEngineListQuerySchema,
  vehicleGenerationIdPathSchema,
  vehicleGenerationListQuerySchema,
  vehicleMakeIdPathSchema,
  vehicleMakeListQuerySchema,
  vehicleModelIdPathSchema,
  vehicleModelListQuerySchema,
  vehicleModificationIdPathSchema,
  vehicleModificationListQuerySchema,
  vehicleOptionIdPathSchema,
  vehicleOptionListQuerySchema,
  type AdminVehicleEnginePage,
  type AdminVehicleEngineResponse,
  type AdminVehicleGenerationPage,
  type AdminVehicleGenerationResponse,
  type AdminVehicleMakePage,
  type AdminVehicleMakeResponse,
  type AdminVehicleModelPage,
  type AdminVehicleModelResponse,
  type AdminVehicleModificationPage,
  type AdminVehicleModificationResponse,
  type AdminVehicleOptionListResponse,
  type AdminVehicleOptionResponse,
  type CreateVehicleEngineBody,
  type CreateVehicleGenerationBody,
  type CreateVehicleMakeBody,
  type CreateVehicleModelBody,
  type CreateVehicleModificationBody,
  type CreateVehicleOptionBody,
  type SetVehicleStatusBody,
  type UpdateVehicleEngineBody,
  type UpdateVehicleGenerationBody,
  type UpdateVehicleMakeBody,
  type UpdateVehicleModelBody,
  type UpdateVehicleModificationBody,
  type UpdateVehicleOptionBody,
  type VehicleEngineIdPath,
  type VehicleEngineListQuery,
  type VehicleGenerationIdPath,
  type VehicleGenerationListQuery,
  type VehicleMakeIdPath,
  type VehicleMakeListQuery,
  type VehicleModelIdPath,
  type VehicleModelListQuery,
  type VehicleModificationIdPath,
  type VehicleModificationListQuery,
  type VehicleOptionIdPath,
  type VehicleOptionListQuery,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { adminActor } from "../catalog";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { VehicleHierarchyService } from "./vehicle-hierarchy.service";
import { VehicleModificationsService } from "./vehicle-modifications.service";
import { VehicleOptionsService } from "./vehicle-options.service";

/**
 * The vehicle catalog in the admin panel (context `admin`; TASK-014;
 * SCREENS A-CAR-01). The screens themselves are TASK-035.
 */
@Controller()
export class VehicleAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(VehicleOptionsService) private readonly options: VehicleOptionsService,
    @Inject(VehicleHierarchyService) private readonly hierarchy: VehicleHierarchyService,
    @Inject(VehicleModificationsService)
    private readonly modifications: VehicleModificationsService,
  ) {}

  // --------------------------------------------------------------- options

  @SessionRoute(apiRoutes.listVehicleOptions)
  async listOptions(
    @Query(new ZodValidationPipe(vehicleOptionListQuerySchema)) query: VehicleOptionListQuery,
  ): Promise<AdminVehicleOptionListResponse> {
    return { options: await this.options.list(query) };
  }

  @SessionRoute(apiRoutes.createVehicleOption)
  async createOption(
    @Body(new ZodValidationPipe(createVehicleOptionBodySchema)) body: CreateVehicleOptionBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleOptionResponse> {
    return { option: await this.options.create(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.updateVehicleOption)
  async updateOption(
    @Param(new ZodValidationPipe(vehicleOptionIdPathSchema)) params: VehicleOptionIdPath,
    @Body(new ZodValidationPipe(updateVehicleOptionBodySchema)) body: UpdateVehicleOptionBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleOptionResponse> {
    return { option: await this.options.update(params.optionId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.setVehicleOptionStatus)
  async setOptionStatus(
    @Param(new ZodValidationPipe(vehicleOptionIdPathSchema)) params: VehicleOptionIdPath,
    @Body(new ZodValidationPipe(setVehicleStatusBodySchema)) body: SetVehicleStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleOptionResponse> {
    return {
      option: await this.options.setStatus(
        params.optionId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  // ----------------------------------------------------------------- makes

  @SessionRoute(apiRoutes.listVehicleMakes)
  listMakes(
    @Query(new ZodValidationPipe(vehicleMakeListQuerySchema)) query: VehicleMakeListQuery,
  ): Promise<AdminVehicleMakePage> {
    return this.hierarchy.makePage(query);
  }

  @SessionRoute(apiRoutes.createVehicleMake)
  async createMake(
    @Body(new ZodValidationPipe(createVehicleMakeBodySchema)) body: CreateVehicleMakeBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleMakeResponse> {
    return { make: await this.hierarchy.createMake(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.updateVehicleMake)
  async updateMake(
    @Param(new ZodValidationPipe(vehicleMakeIdPathSchema)) params: VehicleMakeIdPath,
    @Body(new ZodValidationPipe(updateVehicleMakeBodySchema)) body: UpdateVehicleMakeBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleMakeResponse> {
    return { make: await this.hierarchy.updateMake(params.makeId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.setVehicleMakeStatus)
  async setMakeStatus(
    @Param(new ZodValidationPipe(vehicleMakeIdPathSchema)) params: VehicleMakeIdPath,
    @Body(new ZodValidationPipe(setVehicleStatusBodySchema)) body: SetVehicleStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleMakeResponse> {
    return {
      make: await this.hierarchy.setMakeStatus(
        params.makeId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  // ---------------------------------------------------------------- models

  @SessionRoute(apiRoutes.listVehicleModels)
  listModels(
    @Query(new ZodValidationPipe(vehicleModelListQuerySchema)) query: VehicleModelListQuery,
  ): Promise<AdminVehicleModelPage> {
    return this.hierarchy.modelPage(query);
  }

  @SessionRoute(apiRoutes.createVehicleModel)
  async createModel(
    @Body(new ZodValidationPipe(createVehicleModelBodySchema)) body: CreateVehicleModelBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleModelResponse> {
    return { model: await this.hierarchy.createModel(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.updateVehicleModel)
  async updateModel(
    @Param(new ZodValidationPipe(vehicleModelIdPathSchema)) params: VehicleModelIdPath,
    @Body(new ZodValidationPipe(updateVehicleModelBodySchema)) body: UpdateVehicleModelBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleModelResponse> {
    return { model: await this.hierarchy.updateModel(params.modelId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.setVehicleModelStatus)
  async setModelStatus(
    @Param(new ZodValidationPipe(vehicleModelIdPathSchema)) params: VehicleModelIdPath,
    @Body(new ZodValidationPipe(setVehicleStatusBodySchema)) body: SetVehicleStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleModelResponse> {
    return {
      model: await this.hierarchy.setModelStatus(
        params.modelId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  // ----------------------------------------------------------- generations

  @SessionRoute(apiRoutes.listVehicleGenerations)
  listGenerations(
    @Query(new ZodValidationPipe(vehicleGenerationListQuerySchema))
    query: VehicleGenerationListQuery,
  ): Promise<AdminVehicleGenerationPage> {
    return this.hierarchy.generationPage(query);
  }

  @SessionRoute(apiRoutes.createVehicleGeneration)
  async createGeneration(
    @Body(new ZodValidationPipe(createVehicleGenerationBodySchema))
    body: CreateVehicleGenerationBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleGenerationResponse> {
    return { generation: await this.hierarchy.createGeneration(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.updateVehicleGeneration)
  async updateGeneration(
    @Param(new ZodValidationPipe(vehicleGenerationIdPathSchema)) params: VehicleGenerationIdPath,
    @Body(new ZodValidationPipe(updateVehicleGenerationBodySchema))
    body: UpdateVehicleGenerationBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleGenerationResponse> {
    return {
      generation: await this.hierarchy.updateGeneration(
        params.generationId,
        body,
        adminActor(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.setVehicleGenerationStatus)
  async setGenerationStatus(
    @Param(new ZodValidationPipe(vehicleGenerationIdPathSchema)) params: VehicleGenerationIdPath,
    @Body(new ZodValidationPipe(setVehicleStatusBodySchema)) body: SetVehicleStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleGenerationResponse> {
    return {
      generation: await this.hierarchy.setGenerationStatus(
        params.generationId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  // --------------------------------------------------------------- engines

  @SessionRoute(apiRoutes.listVehicleEngines)
  listEngines(
    @Query(new ZodValidationPipe(vehicleEngineListQuerySchema)) query: VehicleEngineListQuery,
  ): Promise<AdminVehicleEnginePage> {
    return this.modifications.enginePage(query);
  }

  @SessionRoute(apiRoutes.createVehicleEngine)
  async createEngine(
    @Body(new ZodValidationPipe(createVehicleEngineBodySchema)) body: CreateVehicleEngineBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleEngineResponse> {
    return { engine: await this.modifications.createEngine(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.updateVehicleEngine)
  async updateEngine(
    @Param(new ZodValidationPipe(vehicleEngineIdPathSchema)) params: VehicleEngineIdPath,
    @Body(new ZodValidationPipe(updateVehicleEngineBodySchema)) body: UpdateVehicleEngineBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleEngineResponse> {
    return {
      engine: await this.modifications.updateEngine(params.engineId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.setVehicleEngineStatus)
  async setEngineStatus(
    @Param(new ZodValidationPipe(vehicleEngineIdPathSchema)) params: VehicleEngineIdPath,
    @Body(new ZodValidationPipe(setVehicleStatusBodySchema)) body: SetVehicleStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleEngineResponse> {
    return {
      engine: await this.modifications.setEngineStatus(
        params.engineId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  // --------------------------------------------------------- modifications

  @SessionRoute(apiRoutes.listVehicleModifications)
  listModifications(
    @Query(new ZodValidationPipe(vehicleModificationListQuerySchema))
    query: VehicleModificationListQuery,
  ): Promise<AdminVehicleModificationPage> {
    return this.modifications.modificationPage(query);
  }

  @SessionRoute(apiRoutes.createVehicleModification)
  async createModification(
    @Body(new ZodValidationPipe(createVehicleModificationBodySchema))
    body: CreateVehicleModificationBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleModificationResponse> {
    return {
      modification: await this.modifications.createModification(body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.updateVehicleModification)
  async updateModification(
    @Param(new ZodValidationPipe(vehicleModificationIdPathSchema))
    params: VehicleModificationIdPath,
    @Body(new ZodValidationPipe(updateVehicleModificationBodySchema))
    body: UpdateVehicleModificationBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleModificationResponse> {
    return {
      modification: await this.modifications.updateModification(
        params.modificationId,
        body,
        adminActor(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.setVehicleModificationStatus)
  async setModificationStatus(
    @Param(new ZodValidationPipe(vehicleModificationIdPathSchema))
    params: VehicleModificationIdPath,
    @Body(new ZodValidationPipe(setVehicleStatusBodySchema)) body: SetVehicleStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleModificationResponse> {
    return {
      modification: await this.modifications.setModificationStatus(
        params.modificationId,
        body.status,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }
}
