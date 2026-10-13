import { Controller, Get, Inject, Logger, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiException } from "../../common/errors";
import { PRICE_EXPORT_DOWNLOAD_PATH, PriceExportService } from "./price-export.service";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The download of «Скачать мой прайс» (TASK-048; ARCHITECTURE 4.68).
 * Outside the client contract, like `/metrics`: the answer is a file, not
 * JSON, and the browser opens it as a plain link — so the session's access
 * token is not what lets it in, the signed token of the link is
 * (`PriceExportService.link`: this employee, this company, two minutes; the
 * token is in the query, which the access log never writes). An employee
 * removed meanwhile downloads nothing. The workbook goes out as it is
 * written, with the response's back pressure.
 */
@Controller()
export class PriceExportController {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PriceExportService) private readonly exports: PriceExportService) {}

  @Get(PRICE_EXPORT_DOWNLOAD_PATH)
  async download(
    @Query("token") token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const claim = this.exports.verify(typeof token === "string" ? token : undefined);
    if (!(await this.exports.memberActive(claim))) {
      throw new ApiException(403, "SUPPLIER_ACCESS_CLOSED", "Access to the cabinet is closed");
    }
    const fileName = this.exports.fileName();
    response.status(200);
    response.setHeader("Content-Type", XLSX);
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    let closed = false;
    response.on("close", () => {
      closed = true;
    });
    try {
      await this.exports.write(claim, async (chunk) => {
        if (closed) throw new Error("The download was cancelled");
        if (!response.write(chunk)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              response.off("drain", done);
              response.off("close", done);
              resolve();
            };
            response.on("drain", done);
            response.on("close", done);
          });
        }
      });
      response.end();
    } catch (error) {
      // The headers are gone already: the broken file is all the browser gets.
      this.logger.warn(
        `Price list export stopped supplier=${claim.supplierId}: ${(error as Error).message}`,
      );
      response.destroy();
    }
  }
}
