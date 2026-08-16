# Magnet Mayhem

## Dev server: the user runs it, not Claude

The user keeps `npm run dev` running on the **default port 5173** for the whole
session. **Never start it**, and never pick an alternate port. Assume 5173 is
already serving and that the user will reload to see changes.

The same goes for the game server (`npm run serve`, port 8080) once the user has
it up. The one exception is `npm run netcheck`, which boots its own throwaway
server on port 8099 and kills it again — that is self-contained and safe.

Verify work with these instead — all headless, no browser needed:

```bash
npm run typecheck          # client + server
npm run smoke              # the whole simulation under plain Node
npm run build
npm run netcheck --workspace server   # boots a real server, two real clients
```

If a background process is ever genuinely unavoidable, spawn `node` directly
rather than through `npx` (the wrapper leaves a grandchild that survives
SIGTERM and holds the stdout pipe open), kill the whole process group rather
than `$!`, and confirm the port is free before finishing the turn.

## Layout

Three npm workspaces, one lockfile and one `node_modules` at the root.

```
shared/     @magnet/shared — the sim + wire protocol. No Three.js, DOM or sockets.
client/     renderer, input, debug UI. Runs the sim solo; renders snapshots online.
server/     authoritative rooms. Owns no physics code — it runs @magnet/shared/sim.
```

`shared/` is a private package that ships raw TypeScript (`exports` points at
`src/`), so there is no build step and no version skew. It declares its own
rapier dependency; client and server must not re-declare it.

## Phase

Phase 4 in progress: server-authoritative multiplayer over WebSocket, snapshot
interpolation, no client prediction yet.

- [client/README.md](client/README.md) — controls, tuning, the four constraints
- [server/README.md](server/README.md) — netcode model and what is deliberately missing
