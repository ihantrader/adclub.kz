import type { ClientUpdateRequiredDetails } from "@adclub/contracts";

/** HTTP 426 Upgrade Required: the client itself must be upgraded. */
export const CLIENT_UPDATE_REQUIRED_STATUS = 426;

/**
 * Thrown when a known client is below the supported minimum version
 * (ARCHITECTURE 7.4). The global exception filter turns it into the
 * unified error with code `CLIENT_UPDATE_REQUIRED`; `message` is the
 * localized update text from the client policy.
 */
export class ClientUpdateRequiredException extends Error {
  constructor(
    message: string,
    public readonly details: ClientUpdateRequiredDetails,
  ) {
    super(message);
    this.name = "ClientUpdateRequiredException";
  }
}
