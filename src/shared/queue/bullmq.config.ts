import IORedis, { Redis } from 'ioredis';

export const createRedisConnection = (redisUrl: string): Redis =>
  new IORedis(redisUrl, {
    // Required for BullMQ in v5
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
