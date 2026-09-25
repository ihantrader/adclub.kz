import { Module, type DynamicModule } from "@nestjs/common";
import { AdminSignalsController } from "./admin-signals.controller";
import { AdminSignals } from "./admin-signals.service";

export interface SignalsModuleOptions {
  /** Serve the admin route (the API process only). */
  http: boolean;
}

/**
 * Signals to the administrator (ARCHITECTURE 5.11, 6.5, 6.6, 4.32;
 * TASK-022): the one place that writes down a fact a person has to look at
 * and the list the admin panel reads. The modules that notice such facts
 * (orders now; billing, reviews and the WhatsApp outage detector later)
 * take this very instance and raise signals inside their own transactions.
 */
@Module({})
export class SignalsModule {
  static forRoot(options: SignalsModuleOptions): DynamicModule {
    return {
      module: SignalsModule,
      controllers: options.http ? [AdminSignalsController] : [],
      providers: [AdminSignals],
      exports: [AdminSignals],
    };
  }
}
