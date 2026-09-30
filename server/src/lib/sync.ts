import { DurableObject } from 'cloudflare:workers';
import type { AppEnv } from './env';

export type SyncEvent =
  | { type: 'created'; bookmark: Record<string, unknown> }
  | { type: 'updated'; bookmark: Record<string, unknown> }
  | { type: 'deleted'; id: string }
  | { type: 'refresh' };

export class SyncHub extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(event: SyncEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  // No webSocketMessage/webSocketClose: defining them wakes the hub.
}

export function getHub(env: AppEnv): DurableObjectStub<SyncHub> {
  return env.SYNC.get(env.SYNC.idFromName('global'));
}

export function publish(env: AppEnv, event: SyncEvent): Promise<void> {
  return getHub(env).broadcast(event);
}
