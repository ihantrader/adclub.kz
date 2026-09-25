import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiException } from "../../common/errors";
import { StorageService } from "../../storage";

/**
 * The object storage as the catalog uses it (ARCHITECTURE 4.22, 15.2):
 * where a photo's files live, how a client is given a link to one, and
 * what removing them means.
 *
 * Keys are `catalog-photos/<itemId>/<photoId>/<variant>.<ext>`: the class
 * of object is the prefix (15.2), and the photo's random id makes a key
 * impossible to guess. The bucket itself is private — a client never
 * reaches a file except through a signed link with a limited life, and a
 * link signs exactly one key, so it opens no other file.
 *
 * Signing is arithmetic, not a request: links are produced while the
 * storage is down, and reading the catalog goes on working (requirement 6).
 */

export const CATALOG_PHOTO_PREFIX = "catalog-photos/";

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function photoObjectKey(
  itemId: string,
  photoId: string,
  variant: string,
  contentType: string,
): string {
  const extension = EXTENSION[contentType] ?? "bin";
  return `${CATALOG_PHOTO_PREFIX}${itemId}/${photoId}/${variant}.${extension}`;
}

export interface StoredObject {
  key: string;
  lastModified: Date | null;
}

/** HTTP 503: the object storage is down; the same request will work later. */
export function storageUnavailable(): ApiException {
  return new ApiException(
    503,
    "SERVICE_UNAVAILABLE",
    "The file storage is temporarily unavailable, repeat the upload",
    { retryable: true },
  );
}

@Injectable()
export class PhotoStorage {
  private readonly logger = new Logger("CatalogPhotos");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  /**
   * Stores one object. A failure of the storage becomes a 503 the client
   * can repeat — never a 500 and never a half-written photo: the database
   * row is written only after every object is in place. What the storage
   * actually said goes to the log: «временно недоступно» without a cause
   * leaves nothing to act on, and the key names no person.
   */
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    try {
      await this.storage.client.send(
        new PutObjectCommand({
          Bucket: this.storage.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          // The bucket is private; this only spares a guess if it ever
          // gets served through a proxy.
          CacheControl: "private, max-age=31536000",
        }),
      );
    } catch (error) {
      const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.warn(`Photo upload refused by the storage key=${key} cause=${cause}`);
      throw storageUnavailable();
    }
  }

  /**
   * A link to one object, good for `ttlSeconds`. Nothing is asked of the
   * storage: the link is computed from the key and the credentials, so an
   * unreachable storage doesn't stop the catalog from answering.
   */
  signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.storage.client,
      new GetObjectCommand({ Bucket: this.storage.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  /** Removes objects; removing one that is already gone is not a failure. */
  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    // S3 takes 1000 keys at a time.
    for (let from = 0; from < keys.length; from += 1000) {
      const batch = keys.slice(from, from + 1000);
      await this.storage.client.send(
        new DeleteObjectsCommand({
          Bucket: this.storage.bucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
    }
  }

  /** Every object of the catalog's photos, oldest pages first. */
  async list(limit: number): Promise<StoredObject[]> {
    const found: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.storage.client.send(
        new ListObjectsV2Command({
          Bucket: this.storage.bucket,
          Prefix: CATALOG_PHOTO_PREFIX,
          ContinuationToken: continuationToken,
          MaxKeys: Math.min(1000, limit - found.length),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) {
          found.push({ key: object.Key, lastModified: object.LastModified ?? null });
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken && found.length < limit);
    return found;
  }
}
