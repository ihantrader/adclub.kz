import { Module, type DynamicModule } from "@nestjs/common";
import { DocumentAttempts } from "./document-attempts";
import { DocumentProofs } from "./document-proofs";
import { VehicleDocumentController } from "./vehicle-document.controller";
import { VehicleDocumentService } from "./vehicle-document.service";

export interface VehicleDocumentModuleOptions {
  /** The vehicle catalog module of the app, made once (`AppModule`): the fields are placed in it. */
  vehicles: DynamicModule;
}

/**
 * A car read off a photographed Kazakhstan registration certificate
 * (D-064, TASK-057; ARCHITECTURE 4.58). `DocumentProofs` is exported: the
 * garage checks the proof a car is saved with («документ показан»).
 */
@Module({})
export class VehicleDocumentModule {
  static forRoot(options: VehicleDocumentModuleOptions): DynamicModule {
    return {
      module: VehicleDocumentModule,
      imports: [options.vehicles],
      controllers: [VehicleDocumentController],
      providers: [DocumentAttempts, DocumentProofs, VehicleDocumentService],
      exports: [DocumentProofs],
    };
  }
}
