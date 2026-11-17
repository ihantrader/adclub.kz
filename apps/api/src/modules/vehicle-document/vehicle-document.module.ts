import { Module, type DynamicModule } from "@nestjs/common";
import { DocumentAttempts } from "./document-attempts";
import { DocumentProofs } from "./document-proofs";
import { PhotoRecognitions } from "./photo-recognitions";
import { VehicleDocumentController } from "./vehicle-document.controller";
import { VehicleDocumentService } from "./vehicle-document.service";
import { VehicleMatchController } from "./vehicle-match.controller";
import { VehicleMatching } from "./vehicle-matching";

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
      // The car named by voice (TASK-060) is placed the way a certificate is: `VehicleMatching`.
      controllers: [VehicleDocumentController, VehicleMatchController],
      providers: [
        DocumentAttempts,
        DocumentProofs,
        PhotoRecognitions,
        VehicleDocumentService,
        VehicleMatching,
      ],
      exports: [DocumentProofs],
    };
  }
}
