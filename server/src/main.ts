import { WebSocketServer, type WebSocket } from 'ws';

import { initSim, TICK_DT, TICK_RATE } from '@magnet/shared/sim/World';
import type { ClientMessage, ServerMessage } from '@magnet/shared/net/protocol';

import { Room } from './Room';

const PORT = Number(process.env.PORT ?? 8080);
/** `BOTS=3 npm run serve` fills the room so it is playable solo. */
const BOTS = Number(process.env.BOTS ?? 0);

async function main(): Promise<void> {
  await initSim();

  const room = new Room(BOTS);
  const wss = new WebSocketServer({ port: PORT });

  wss.on('connection', (socket: WebSocket) => {
    if (room.isFull) {
      socket.close(1013, 'room full');
      return;
    }

    const id = room.join({
      send: (message: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      close: () => socket.close(),
    });
    console.log(`+ player ${id} (${room.playerCount} in room)`);

    socket.on('message', (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return; // Malformed frame; ignore rather than kill the room.
      }
      room.receive(id, message);
    });

    const drop = (): void => {
      room.leave(id);
      console.log(`- player ${id} (${room.playerCount} in room)`);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  // Drift-corrected fixed tick. setInterval alone accumulates error, and the
  // sim is only meaningful if every step really is TICK_DT of game time.
  let next = performance.now();
  const loop = (): void => {
    const now = performance.now();
    let steps = 0;
    while (now >= next && steps < 5) {
      room.tick();
      next += TICK_DT * 1000;
      steps++;
    }
    // Fell too far behind (a long GC pause, or the process was suspended):
    // give up on catching up rather than spiralling.
    if (steps === 5) next = now + TICK_DT * 1000;
    setTimeout(loop, Math.max(0, next - performance.now()));
  };
  loop();

  console.log(`magnet-mayhem server on ws://localhost:${PORT} @ ${TICK_RATE}Hz`);
}

void main();
