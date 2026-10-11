import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { ApiException } from "../../common/errors";
import { StorageService } from "../../storage";

/**
 * Files of price lists in the object storage (TASK-046; ARCHITECTURE 4.66,
 * 15.2). Keys are `price-imports/<supplierId>/<importId>`: the class of
 * object is the prefix, and the random id of the import makes a key
 * impossible to guess. The bucket is private and no link to a price file
 * is ever given: the file is the supplier's data, only the worker reads it.
 */

export const PRICE_IMPORT_PREFIX = "price-imports/";

export function priceFileKey(supplierId: string, importId: string): string {
  return `${PRICE_IMPORT_PREFIX}${supplierId}/${importId}`;
}

/** The file is no longer in the storage (removed after its retention). */
export class PriceFileMissing extends Error {
  constructor(key: string) {
    super(`No price file at ${key}`);
    this.name = "PriceFileMissing";
  }
}

@Injectable()
export class PriceFileStorage {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  /** Stores the file; a failure of the storage is a 503 the supplier can repeat. */
  async put(key: string, bytes: Buffer): Promise<void> {
    try {
      await this.storage.client.send(
        new PutObjectCommand({
          Bucket: this.storage.bucket,
          Key: key,
          Body: bytes,
          ContentType: "application/octet-stream",
        }),
      );
    } catch (error) {
      const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.warn(`Price file upload refused by the storage key=${key} cause=${cause}`);
      throw new ApiException(
        503,
        "SERVICE_UNAVAILABLE",
        "The file storage is temporarily unavailable, repeat the upload",
        { retryable: true },
      );
    }
  }

  /** The file's bytes; `PriceFileMissing` when it is gone. */
  async get(key: string): Promise<Buffer> {
    try {
      const answer = await this.storage.client.send(
        new GetObjectCommand({ Bucket: this.storage.bucket, Key: key }),
      );
      if (!answer.Body) throw new PriceFileMissing(key);
      return Buffer.from(await answer.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey) throw new PriceFileMissing(key);
      throw error;
    }
  }

  /** Removes the file; one already gone is not a failure. */
  async remove(key: string): Promise<void> {
    await this.storage.client.send(
      new DeleteObjectCommand({ Bucket: this.storage.bucket, Key: key }),
    );
  }
}
