import { Module } from "@nestjs/common";

/**
 * Empty by design (TASK-002): only the `account` table (`schema.ts`)
 * exists so far. Login, sessions and roles arrive in EPIC-02 (TASK-004
 * to 006) as providers/controllers on this same module.
 */
@Module({})
export class IdentityModule {}
