import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { ApiUploadBodyDefinition } from "@adclub/contracts";
import { ApiException } from "../errors/api.exception";
import { contractPathOf, mediaTypeOf, uploadRouteFor } from "./upload-routes";

/**
 * Reads the body of a file upload as bytes (TASK-013; ARCHITECTURE 4.22).
 * Only routes the contract marks as uploads are touched; every other
 * request goes on to the JSON parsers untouched.
 *
 * The declared type is checked against the types the route takes — a
 * vector picture doesn't even get read — but it decides nothing else: what
 * the file really is is settled by its content later (`photo-image.ts`).
 *
 * The ceiling here is the contract's `maxBytes`: the most the server is
 * ever willing to hold in memory. A body that says it is bigger is refused
 * before a byte is read, and one that turns out bigger while being read is
 * cut off there — neither fills the process. The product limit (the
 * `photo_max_size_mb` setting, which can only be lower) is applied by the
 * handler, so changing it needs no restart.
 */
@Injectable()
export class UploadBodyMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const route = uploadRouteFor(request.method, contractPathOf(request));
    const upload = route?.upload;
    if (!upload) {
      next();
      return;
    }
    const mediaType = mediaTypeOf(request.headers["content-type"]);
    if (!upload.contentTypes.includes(mediaType)) {
      throw new ApiException(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        `This route takes ${upload.contentTypes.join(", ")}`,
      );
    }
    readBody(request, upload).then(
      (body) => {
        request.body = body;
        next();
      },
      (error: unknown) => {
        next(error);
      },
    );
  }
}

function tooLarge(upload: ApiUploadBodyDefinition): ApiException {
  return new ApiException(
    413,
    "PAYLOAD_TOO_LARGE",
    `The file is larger than ${String(Math.round(upload.maxBytes / (1024 * 1024)))} MB`,
  );
}

function incomplete(): ApiException {
  return new ApiException(400, "MALFORMED_REQUEST", "The file was not received whole");
}

/**
 * The bytes of the request. Read by hand rather than with a body parser:
 * the limit must stop the reading itself, and a file is the only body of
 * the API that isn't JSON — there is nothing to parse.
 */
function readBody(request: Request, upload: ApiUploadBodyDefinition): Promise<Buffer> {
  // Something before this middleware read the body already (a parser that was
  // not told to leave this route alone): waiting for `data` and `end` events
  // that have come and gone would hang the request for good. Refuse it.
  if (request.readableEnded || (request.complete && !request.readable)) {
    return Promise.reject(
      new ApiException(
        500,
        "INTERNAL_ERROR",
        "The body of this route was read before it reached its reader",
      ),
    );
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > upload.maxBytes) {
    return Promise.reject(tooLarge(upload));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: ApiException) => {
      if (settled) {
        return;
      }
      settled = true;
      // Stop reading: an oversized body is never taken in whole just to
      // refuse it afterwards.
      request.destroy();
      reject(error);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > upload.maxBytes) {
        fail(tooLarge(upload));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("aborted", () => {
      fail(incomplete());
    });
    request.on("error", () => {
      fail(incomplete());
    });
  });
}
