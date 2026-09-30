import type { SyncHub } from './sync';

export type AppEnv = {
  DB: D1Database;
  SYNC: DurableObjectNamespace<SyncHub>;
  ASSETS: Fetcher;
  AI: Ai;
  LOGIN_LIMITER: RateLimit;
  AUTH_PASSWORD: string;
  AUTH_SECRET: string;
};
