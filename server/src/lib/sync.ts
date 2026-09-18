import { DurableObject } from 'cloudflare:workers';
import type { AppEnv } from './env';

export type SyncEvent =
  | { type: 'created'; bookmark: Record<string, unknown> }
  | { type: 'updated'; bookmark: Record<string, unknown> }
  | { type: 'deleted'; id: string }
  | { type: 'refresh' };

// The app has one bookmark list, so one hub instance serves every client.
const HUB_NAME = 'global';

// Event kinds a client may relay through the hub. 'deleted' lets a tab holding
// an undoable delete hide the row everywhere before the DELETE is sent;
// 'refresh' puts it back if the delete is undone.
const RELAYABLE = new Set<SyncEvent['type']>(['deleted', 'refresh']);

// Broadcast hub for bookmark changes. Every open client holds a WebSocket here
// and every write publishes to it, so a change on one device reaches the others
// immediately instead of on the next poll.
export class SyncHub extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    // Keepalives are answered by the runtime. The hub stays hibernated and
    // incurs no duration charge.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    // Hibernation API: the hub can leave memory while the sockets stay open.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(event: SyncEvent, except?: WebSocket): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(payload);
      } catch {
        // Socket is already gone; the runtime discards it.
      }
    }
  }

  // Relays a change a client is holding locally, so the other tabs see it
  // before it reaches the database. Senders already hold the session cookie
  // and can call the REST API directly, so relaying grants no new privilege.
  // No webSocketClose handler, because the runtime discards closed sockets on
  // its own and defining one would wake the hub on every disconnect.
  webSocketMessage(sender: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;
    let event: SyncEvent;
    try {
      event = JSON.parse(message);
    } catch {
      return; // not ours
    }
    if (!RELAYABLE.has(event?.type)) return;
    this.broadcast(event, sender);
  }
}

export function getHub(env: AppEnv): DurableObjectStub<SyncHub> {
  return env.SYNC.get(env.SYNC.idFromName(HUB_NAME));
}

export function publish(env: AppEnv, event: SyncEvent): Promise<void> {
  return getHub(env).broadcast(event);
}
