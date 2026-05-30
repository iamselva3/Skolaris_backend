import { Global, Module, Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { storageConfig } from '../config/storage.config';
import { OBJECT_STORAGE } from './object-storage.interface';
import { S3Storage } from './s3.storage';
import { StorageReadController } from './storage-read.controller';

// SKOLARIS is S3/R2-only. The factory is retained as a seam so another
// S3-compatible backend could be slotted in later without touching consumers;
// today it always resolves to the S3 adapter (Cloudflare R2 / AWS S3 / MinIO).
const storageProvider: Provider = {
  provide: OBJECT_STORAGE,
  inject: [storageConfig.KEY, S3Storage],
  useFactory: (_cfg, s3: S3Storage) => s3,
};

@Global()
@Module({
  imports: [ConfigModule.forFeature(storageConfig)],
  controllers: [StorageReadController],
  providers: [S3Storage, storageProvider],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
