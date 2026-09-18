import type { SyncHub } from './sync';

export type AppEnv = {
  DB: D1Database;
  SYNC: DurableObjectNamespace<SyncHub>;
  ASSETS: Fetcher;
  AI: Ai;
  AUTH_PASSWORD: string;
  AUTH_SECRET: string;
};
