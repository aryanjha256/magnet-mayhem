import type { Input } from '@magnet/shared/sim/input';
import type { EntityId } from '@magnet/shared/sim/types';
import type { ServerMessage, WelcomeMessage } from '@magnet/shared/net/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface ConnectionHandlers {
  onWelcome(message: WelcomeMessage): void;
  onJoin(id: EntityId): void;
  onLeave(id: EntityId): void;
  onSnapshot(message: ServerMessage & { t: 'snap' }): void;
}

/**
 * Thin WebSocket wrapper. Deliberately owns no game state — it turns frames
 * into callbacks and Inputs into frames, nothing else.
 */
export class Connection {
  status: ConnectionStatus = 'connecting';
  you: EntityId = 0;
  tickRate = 60;
  /** Round-trip estimate is not measured yet; snapshot lag is shown instead. */
  bytesIn = 0;

  private readonly socket: WebSocket;

  constructor(
    url: string,
    private readonly handlers: ConnectionHandlers,
  ) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('open', () => {
      this.status = 'open';
    });
    this.socket.addEventListener('close', () => {
      this.status = 'closed';
    });
    this.socket.addEventListener('error', () => {
      this.status = 'error';
    });
    this.socket.addEventListener('message', (event) => this.onMessage(event));
  }

  send(input: Input): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        t: 'input',
        tick: input.tick,
        mx: round(input.moveX),
        mz: round(input.moveZ),
        ax: round(input.aimX),
        az: round(input.aimZ),
        mag: round(input.magnet),
        dash: input.dash ? 1 : 0,
      }),
    );
  }

  close(): void {
    this.socket.close();
  }

  private onMessage(event: MessageEvent): void {
    const raw = String(event.data);
    this.bytesIn += raw.length;

    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (message.t) {
      case 'welcome':
        this.you = message.you;
        this.tickRate = message.tickRate;
        this.handlers.onWelcome(message);
        break;
      case 'join':
        this.handlers.onJoin(message.id);
        break;
      case 'leave':
        this.handlers.onLeave(message.id);
        break;
      case 'snap':
        this.handlers.onSnapshot(message);
        break;
    }
  }
}

/** Three decimals is well under what the renderer can show, and halves frames. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
