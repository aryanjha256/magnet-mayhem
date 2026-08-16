# server/

Authoritative rooms over WebSocket.

```bash
npm run serve                          # from the repo root, port 8080
npm run netcheck --workspace server    # boots a real server + two real clients
```

Then open two tabs at `http://localhost:5173/?online`. Keyboard in one, gamepad
in the other. `?server=ws://host:port` points at a different machine.

## It owns no physics code

`Room.tick()` is `world.step(inputs)`. The server runs the exact `SimWorld` the
single-player sandbox runs, because `shared/sim` never imported Three.js or the
DOM. That constraint was cheap in Phase 1 and is the reason this directory is
~150 lines instead of a rewrite.

## The netcode model

| | |
|---|---|
| Sim | 60 Hz, fixed timestep, drift-corrected |
| Snapshots | 20 Hz (every 3rd tick), broadcast to everyone |
| Client | renders ~6 ticks (100 ms) behind, interpolating between snapshots |
| Prediction | **none yet** |

Clients send intent; the server decides. Inputs are clamped on arrival — a
hand-written socket sending `NaN` or a magnet axis of `500` must not be able to
drive the room's physics, and `netcheck` asserts it cannot.

The most recent input per player is held rather than queued, so a dropped packet
repeats the previous intent instead of stalling. That is the right failure mode
for a held button. `dash` is cleared after each tick because it is an edge, not
a state.

## What is deliberately missing

**Client prediction.** Everything renders 100 ms in the past, including your own
player, so input feels laggy on a real network. Adding prediction for your own
player is the obvious next step; it slots on top of the snapshot buffer.

**No rollback, ever.** Re-simulating a shared physics world for every late
packet is where this kind of project dies. The fixed interpolation delay is the
whole mitigation.

The specific cost for *this* game: the ball you aim at is where it *was*. Most
games hide that; this one can't, because manipulating objects is the mechanic.
The eventual fix is to locally predict only the bodies inside your own magnet
radius and blend them back to server truth on release.

**One room, no lobby.** Everyone lands in the same game, capped at 8. Rooms and
shareable codes are Phase 5.

**JSON frames.** ~1 KB per snapshot, ~20 KB/s per client. Fine for small rooms;
the flat number arrays in `shared/net/protocol.ts` are already the layout a
binary quantized encoder would want.

**No kill attribution.** A player knocked into the void credits whoever is first
in the map. Real credit needs last-touched tracking.
