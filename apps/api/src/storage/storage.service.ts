import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { DependencyCheck } from "@adclub/contracts";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { APP_CONFIG, type AppConfig } from "../config";
import { measureCheck } from "../common/health/measure-check";

@Injectable()
export class StorageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);
  readonly client: S3Client;
  readonly bucket: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.storage.bucket;
    this.client = new S3Client({
      endpoint: config.storage.endpoint,
      region: config.storage.region,
      // Required for MinIO/S3-compatible endpoints (ARCHITECTURE 15.1);
      // works against real AWS S3 too.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.storage.accessKey,
        secretAccessKey: config.storage.secretKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    const check = await this.checkHealth();
    if (check.status === "error") {
      this.logger.warn(`S3-compatible storage not reachable at startup: ${check.error}`);
    }
  }

  checkHealth(): Promise<DependencyCheck> {
    return measureCheck(async () => {
      await this.client.send(new ListBucketsCommand({}));
    });
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
