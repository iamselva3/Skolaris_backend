import { Global, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { storageConfig } from '../config/storage.config';
import { GcsStorage } from './gcs.storage';
import { OBJECT_STORAGE } from './object-storage.interface';
import { S3Storage } from './s3.storage';
import { StorageReadController } from './storage-read.controller';

const storageProvider: Provider = {
  provide: OBJECT_STORAGE,
  inject: [storageConfig.KEY, GcsStorage, S3Storage],
  useFactory: (cfg: ConfigType<typeof storageConfig>, gcs: GcsStorage, s3: S3Storage) =>
    cfg.provider === 's3' ? s3 : gcs,
};

@Global()
@Module({
  imports: [ConfigModule.forFeature(storageConfig)],
  controllers: [StorageReadController],
  providers: [GcsStorage, S3Storage, storageProvider],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
