import type { ErrorCode } from "@adclub/contracts";
import { ApiException } from "./api.exception";

/**
 * An error the body parser (`body-parser` through Express) raised before
 * any handler ran: an `http-errors` error with a 4xx `status` and a `type`.
 */
interface BodyParserError {
  status: number;
  type?: unknown;
  expose?: unknown;
}

/** What the client is told about a body the parser refused. */
function describe(error: BodyParserError): { code: ErrorCode; message: string } {
  switch (error.type) {
    case "entity.parse.failed":
      return { code: "MALFORMED_REQUEST", message: "The request body is not valid JSON" };
    case "request.aborted":
    case "request.size.invalid":
      return { code: "MALFORMED_REQUEST", message: "The request body was not received whole" };
    case "entity.too.large":
    case "parameters.too.many":
      return { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large" };
    case "charset.unsupported":
    case "encoding.unsupported":
      return {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request body is in an encoding the API does not accept",
      };
    default:
      return { code: "REQUEST_REJECTED", message: "The request was rejected" };
  }
}

/**
 * The contract error for a body the parser refused (TASK-009.A), or
 * `undefined` for anything else. Its own message is never passed on: for a
 * body that isn't JSON it may quote the body. Before this, such requests
 * answered 500 (and were reported to monitoring as failures of the API).
 */
export function bodyParserException(error: unknown): ApiException | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const { status, type, expose } = error as Error & Partial<BodyParserError>;
  if (
    typeof status !== "number" ||
    status < 400 ||
    status > 499 ||
    expose !== true ||
    typeof type !== "string"
  ) {
    return undefined;
  }
  const { code, message } = describe({ status, type });
  return new ApiException(status, code, message);
}
