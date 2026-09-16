import { Module } from "@nestjs/common";

/**
 * Empty by design (TASK-001): the worker process boots and can shut down
 * cleanly. Background jobs (pg-boss processors) are added in later tasks.
 */
@Module({})
export class WorkerModule {}
