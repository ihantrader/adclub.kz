import { Module } from "@nestjs/common";
import { SpeechAttempts } from "./speech-attempts";
import { SpeechController } from "./speech.controller";
import { SpeechRecognitions } from "./speech.service";

/**
 * Voice input (TASK-059; ARCHITECTURE 4.90): a recording heard by a
 * language model through `AiService` (D-055) — no separate speech provider.
 * `SpeechRecognitions` is exported for the other points of voice input
 * (the mileage, the car, the assistant — TASK-060).
 */
@Module({
  controllers: [SpeechController],
  providers: [SpeechAttempts, SpeechRecognitions],
  exports: [SpeechRecognitions],
})
export class SpeechModule {}
