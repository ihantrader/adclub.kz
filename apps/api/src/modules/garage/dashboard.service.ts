import { Inject, Injectable, Logger } from "@nestjs/common";
import type { DashboardResponse } from "@adclub/contracts";
import { isMileageInRange, milesToKm } from "@adclub/domain";
import { AiService, type DashboardOutput } from "../ai";
import { PhotoRecognitions, type DocumentReader } from "../vehicle-document";

/** A share kept within 0…1, two decimals: what a provider says is not trusted to be. */
export function shareOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/**
 * The answer about a dashboard, from what the model read (TASK-058): miles
 * become kilometres (rounded, `unit: "mi"` says so); a «dashboard» without
 * a number, or with a number no car has, is unreadable — never a guess
 * passed on. Whatever else the model said was dropped by the schema.
 */
export function dashboardAnswer(
  output: DashboardOutput,
): Pick<DashboardResponse, "kind" | "mileageKm" | "unit" | "confidence" | "tripMeterSeen"> {
  const none = {
    mileageKm: null,
    unit: null,
    confidence: shareOf(output.confidence),
    tripMeterSeen: false,
  };
  if (output.kind !== "dashboard") return { kind: output.kind, ...none };
  if (output.totalMileage === null) return { kind: "unreadable", ...none };
  const unit = output.unit ?? "km";
  const mileageKm = unit === "mi" ? milesToKm(output.totalMileage) : output.totalMileage;
  if (!isMileageInRange(mileageKm)) return { kind: "unreadable", ...none };
  return {
    kind: "dashboard",
    mileageKm,
    unit,
    confidence: shareOf(output.confidence),
    tripMeterSeen: output.tripMeterSeen,
  };
}

/**
 * The mileage read off a photo of the dashboard (TASK-058; SCREENS
 * M-GAR-07, M-GAR-05): through the one way a photo reaches AI
 * (`PhotoRecognitions` — counted with the certificate, stored nowhere).
 * Nothing is written: the person checks the reading and saves it
 * (`POST /garage/cars/{carId}/mileage`, or on the device as a guest).
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger("Dashboard");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(PhotoRecognitions) private readonly photos: PhotoRecognitions,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  async recognize(reader: DocumentReader, body: Buffer): Promise<DashboardResponse> {
    const reading = await this.photos.read(reader, body, (input, meta) =>
      this.ai.readDashboard(input, meta),
    );
    const answer = dashboardAnswer(reading.call.output);
    // The kind and the unit — never the reading.
    this.logger.log(`Dashboard read result=${answer.kind} unit=${answer.unit ?? "-"}`);
    return {
      ...answer,
      recognitionId: answer.kind === "dashboard" ? reading.call.jobId : null,
      attempts: reading.attempts,
    };
  }
}
