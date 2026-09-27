import { Body, Controller, Inject, Param } from "@nestjs/common";
import {
  apiRoutes,
  garageCarIdPathSchema,
  saveGarageCarBodySchema,
  transferGarageBodySchema,
  type AccountCar,
  type GarageCarIdPath,
  type GarageCarRemovedResponse,
  type GarageCarsResponse,
  type SaveGarageCarBody,
  type TransferGarageBody,
  type TransferGarageResponse,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { GarageService } from "./garage.service";

/** The account's own garage, once signed in (ARCHITECTURE 4.41; TASK-029). */
@Controller()
export class GarageController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(GarageService) private readonly garage: GarageService) {}

  @SessionRoute(apiRoutes.listGarageCars)
  list(@CurrentSession() session: AuthenticatedSession): Promise<GarageCarsResponse> {
    return this.garage.list(session.accountId);
  }

  @SessionRoute(apiRoutes.addGarageCar)
  add(
    @Body(new ZodValidationPipe(saveGarageCarBodySchema)) body: SaveGarageCarBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AccountCar> {
    return this.garage.add(session.accountId, body);
  }

  @SessionRoute(apiRoutes.updateGarageCar)
  update(
    @Param(new ZodValidationPipe(garageCarIdPathSchema)) params: GarageCarIdPath,
    @Body(new ZodValidationPipe(saveGarageCarBodySchema)) body: SaveGarageCarBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AccountCar> {
    return this.garage.update(session.accountId, params.carId, body);
  }

  @SessionRoute(apiRoutes.removeGarageCar)
  async remove(
    @Param(new ZodValidationPipe(garageCarIdPathSchema)) params: GarageCarIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<GarageCarRemovedResponse> {
    await this.garage.remove(session.accountId, params.carId);
    return { removed: true };
  }

  @SessionRoute(apiRoutes.setPrimaryGarageCar)
  setPrimary(
    @Param(new ZodValidationPipe(garageCarIdPathSchema)) params: GarageCarIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AccountCar> {
    return this.garage.setPrimary(session.accountId, params.carId);
  }

  @SessionRoute(apiRoutes.transferGarage)
  transfer(
    @Body(new ZodValidationPipe(transferGarageBodySchema)) body: TransferGarageBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<TransferGarageResponse> {
    return this.garage.transfer(session.accountId, body);
  }
}
