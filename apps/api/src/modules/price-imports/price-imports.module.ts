import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "../../jobs";
import { PriceFileStorage } from "./price-file-storage";
import {
  deletePriceFilesJob,
  expirePriceImportsJob,
  parsePriceFileJob,
  readPriceValuesJob,
} from "./price-import-jobs";
import {
  PriceFileDeletion,
  PriceFileParser,
  PriceImportExpiry,
  PriceValuesReader,
} from "./price-import-runner";
import { PriceImportsAdminController, PriceImportsController } from "./price-imports.controller";
import { PriceImportsService } from "./price-imports.service";

/**
 * Price list imports (ARCHITECTURE 5.6, 12.1, 4.66; TASK-046): the upload and
 * the cabinet's routes in the API process.
 */
@Module({
  controllers: [PriceImportsController, PriceImportsAdminController],
  providers: [PriceImportsService, PriceFileStorage],
})
export class PriceImportsModule {}

/** Reading price files and their rows, for the worker process. */
@Module({
  providers: [
    PriceFileStorage,
    PriceValuesReader,
    PriceFileParser,
    PriceImportExpiry,
    PriceFileDeletion,
  ],
})
export class PriceImportJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(PriceFileParser) private readonly parser: PriceFileParser,
    @Inject(PriceValuesReader) private readonly values: PriceValuesReader,
    @Inject(PriceImportExpiry) private readonly expiry: PriceImportExpiry,
    @Inject(PriceFileDeletion) private readonly files: PriceFileDeletion,
  ) {}

  onModuleInit(): void {
    this.registry.handle(parsePriceFileJob, this.parser);
    this.registry.handle(readPriceValuesJob, this.values);
    this.registry.handlePeriodic(expirePriceImportsJob, this.expiry);
    this.registry.sweep(deletePriceFilesJob, this.files);
  }
}
