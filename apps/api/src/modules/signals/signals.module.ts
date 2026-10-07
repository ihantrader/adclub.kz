import { Module, type DynamicModule } from "@nestjs/common";
import { AccountDirectory } from "../identity";
import { AdminSignalsController } from "./admin-signals.controller";
import { AdminSignals } from "./admin-signals.service";

export interface SignalsModuleOptions {
  /** Serve the admin routes (the API process only). */
  http: boolean;
}

/**
 * Signals to the administrator (ARCHITECTURE 5.11, 6.5, 6.6, 4.32, 4.52;
 * TASK-022, TASK-034): the one place that writes down a fact a person has to
 * look at, the list the admin panel reads and the administrator's actions on
 * it. The modules that notice such facts (orders: the late close, the
 * closes by an administrator, the outage of the channel, the unreachable
 * supplier; billing and reviews later) take this very instance and raise
 * signals inside their own transactions.
 */
@Module({})
export class SignalsModule {
  static forRoot(options: SignalsModuleOptions): DynamicModule {
    return {
      module: SignalsModule,
      controllers: options.http ? [AdminSignalsController] : [],
      providers: [AdminSignals, AccountDirectory],
      exports: [AdminSignals],
    };
  }
}
