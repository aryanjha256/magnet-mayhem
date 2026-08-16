/**
 * End-to-end check: boots the real server, connects two real WebSocket
 * clients, and verifies one can shove the other through the wire.
 *
 * Deliberately not a unit test of Room — the point is to exercise the whole
 * path (socket -> input clamp -> shared sim -> snapshot encode -> socket).
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath, URL } from 'node:url';

import WebSocket from 'ws';

import { BODY_STRIDE, PLAYER_STRIDE, type ServerMessage } from '@magnet/shared/net/protocol';

const PORT = 8099;
const URL_WS = `ws://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? `  ${detail}` : ''}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error('server never listened'));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

class TestClient {
  you = 0;
  players: number[] = [];
  snapshots = 0;
  joins: number[] = [];
  leaves: number[] = [];
  latest: Extract<ServerMessage, { t: 'snap' }> | null = null;

  private constructor(private readonly socket: WebSocket) {}

  static async connect(): Promise<TestClient> {
    const socket = new WebSocket(URL_WS);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      switch (message.t) {
        case 'welcome':
          client.you = message.you;
          client.players = message.players;
          break;
        case 'join':
          client.joins.push(message.id);
          break;
        case 'leave':
          client.leaves.push(message.id);
          break;
        case 'snap':
          client.snapshots++;
          client.latest = message;
          break;
      }
    });
    return client;
  }

  send(mx: number, mz: number, ax: number, az: number, mag: number): void {
    this.socket.send(
      JSON.stringify({ t: 'input', tick: 0, mx, mz, ax, az, mag, dash: 0 }),
    );
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  bodyOf(id: number): { x: number; y: number; z: number } | null {
    const b = this.latest?.b;
    if (!b) return null;
    for (let i = 0; i < b.length; i += BODY_STRIDE) {
      if (b[i] === id) return { x: b[i + 1]!, y: b[i + 2]!, z: b[i + 3]! };
    }
    return null;
  }

  playerIds(): number[] {
    const p = this.latest?.p ?? [];
    const ids: number[] = [];
    for (let i = 0; i < p.length; i += PLAYER_STRIDE) ids.push(p[i]!);
    return ids;
  }

  close(): void {
    this.socket.close();
  }
}

async function main(): Promise<void> {
  const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  // Spawn node directly rather than through `npx tsx`. The wrapper leaves a
  // grandchild that survives SIGTERM and keeps the stdout pipe open, so this
  // process would never exit.
  const server = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += String(d)));
  server.stderr.on('data', (d) => (serverLog += String(d)));

  try {
    await waitForPort(PORT);

    console.log('\n\x1b[1mHandshake\x1b[0m');
    const a = await TestClient.connect();
    await sleep(300);
    const b = await TestClient.connect();
    await sleep(400);

    check('first client is welcomed', a.you > 0, `id ${a.you}`);
    check('second client gets a distinct id', b.you > 0 && b.you !== a.you, `id ${b.you}`);
    check('late joiner is told about the incumbent', b.players.includes(a.you),
      `saw [${b.players.join(', ')}]`);
    check('incumbent is told about the joiner', a.joins.includes(b.you));
    check('a joiner is not announced to itself', !b.joins.includes(b.you));

    console.log('\n\x1b[1mSnapshots\x1b[0m');
    const before = a.snapshots;
    await sleep(500);
    const rate = (a.snapshots - before) / 0.5;
    check('snapshots arrive at roughly 20Hz', rate > 12 && rate < 28,
      `${rate.toFixed(0)}/s`);
    check('both players appear in the snapshot', a.playerIds().length === 2,
      `${a.playerIds().length} players`);
    check('the arena is included', (a.latest?.b.length ?? 0) / BODY_STRIDE > 10,
      `${(a.latest?.b.length ?? 0) / BODY_STRIDE} bodies`);

    console.log('\n\x1b[1mAuthority\x1b[0m');
    // Garbage must not be able to steer the room's physics.
    a.send(NaN, 0, 0, 1, 99);
    b.sendRaw('{not json');
    await sleep(200);
    const survived = a.bodyOf(a.you);
    // NaN and an out-of-range magnet axis are clamped, not rejected: the room
    // must keep simulating rather than propagate garbage into the physics.
    check('malformed input does not kill the room',
      !!survived && Number.isFinite(survived.x), `x=${survived?.x.toFixed(2)}`);
    a.send(0, 0, 0, 1, 0);
    await sleep(200);

    console.log('\n\x1b[1mOne player shoves the other, over the wire\x1b[0m');
    const posA = a.bodyOf(a.you)!;
    const posB = a.bodyOf(b.you)!;
    const dx = posB.x - posA.x;
    const dz = posB.z - posA.z;
    const len = Math.hypot(dx, dz) || 1;
    // Not a spawn check — the clamp test above already shoved them apart.
    check('the two players are separated', len > 1, `${len.toFixed(2)}m`);

    const start = { ...posB };
    const push = setInterval(() => a.send(0, 0, dx / len, dz / len, 1), 16);
    await sleep(1200);
    clearInterval(push);
    a.send(0, 0, dx / len, dz / len, 0);
    await sleep(200);

    const end = a.bodyOf(b.you)!;
    const moved = Math.hypot(end.x - start.x, end.z - start.z);
    check('the shoved player actually moved', moved > 1, `${moved.toFixed(2)}m`);

    const endFromB = b.bodyOf(b.you)!;
    check('both clients agree on where they are',
      Math.hypot(end.x - endFromB.x, end.z - endFromB.z) < 0.5,
      `${Math.hypot(end.x - endFromB.x, end.z - endFromB.z).toFixed(3)}m apart`);

    console.log('\n\x1b[1mDisconnect\x1b[0m');
    b.close();
    await sleep(400);
    check('the room announces the departure', a.leaves.includes(b.you));
    check('and the body is gone from snapshots', a.bodyOf(b.you) === null);
    check('the survivor is still simulated', a.bodyOf(a.you) !== null);

    a.close();
    await sleep(150);
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    if (server.exitCode === null) server.kill('SIGKILL');
    server.stdout.destroy();
    server.stderr.destroy();
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
  if (failed > 0) console.log('--- server output ---\n' + serverLog);
  // Explicit, because a lingering socket or pipe handle would otherwise hold
  // the event loop open long after the checks are done.
  process.exit(failed > 0 ? 1 : 0);
}

void main();
