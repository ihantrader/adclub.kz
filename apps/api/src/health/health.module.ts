import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database";
import { RedisModule } from "../redis";
import { StorageModule } from "../storage";
import { HealthController } from "./health.controller";
import { ReadinessController } from "./readiness.controller";
import { ReadinessService } from "./readiness.service";

@Module({
  imports: [DatabaseModule, RedisModule, StorageModule],
  controllers: [HealthController, ReadinessController],
  providers: [ReadinessService],
})
export class HealthModule {}
