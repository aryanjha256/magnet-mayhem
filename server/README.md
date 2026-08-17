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
| Remote bodies | rendered ~6 ticks (100 ms) behind, interpolating between snapshots |
| Your own player | **predicted locally**, corrected against the server |
| Bodies you are magnetising | **owned locally** while held, faded back on release |

Clients send intent; the server decides. Inputs are clamped on arrival — a
hand-written socket sending `NaN` or a magnet axis of `500` must not be able to
drive the room's physics, and `netcheck` asserts it cannot.

The most recent input per player is held rather than queued, so a dropped packet
repeats the previous intent instead of stalling. That is the right failure mode
for a held button. `dash` is cleared after each tick because it is an edge, not
a state.

## Prediction, without rollback

The client simulates the whole world but only *owns* its own player. Every other
body is stamped back to the server's version each frame — position **and** a
velocity derived from consecutive snapshots, because a body teleported each tick
at rest collides like a wall instead of like a moving ball.

Reconciliation compares the server's word for tick T against what the client
predicted *at tick T*, then folds that error into the present a fraction at a
time. Comparing against the raw authoritative position instead would drag the
player 100 ms into the past and fight every input. Errors beyond 4 m teleport
rather than slide, since that means a respawn or a stall.

There is deliberately **no rollback**. Re-simulating the shared world for every
late packet is where this kind of project dies.

### Owning the bodies you magnetise

While your magnet acts on a body, the client owns it outright and the server's
version is ignored. On release, ownership fades over ~18 ticks so the body
drifts home instead of teleporting.

Claims come from the local sim's own `links` list, so ownership can never
disagree with what the physics actually did. Two guardrails, because getting
this wrong feels *worse* than plain lag:

- **Never own another player.** They are driven by input we cannot see, so a
  prediction would diverge immediately and rubber-band.
- **Abandon on divergence.** Past `objectDivergenceLimit` metres, somebody else
  is pulling the same body and we were simply wrong — hand it straight back.

Remote players' magnets are replayed locally from their last reported aim and
polarity. Their *movement* does not matter (their positions get stamped anyway),
but their pull on shared objects does: without it, any contested ball diverges
instantly and gets abandoned every frame.

All of it is live-toggleable under **Net** in the tuner — `predictObjects` to 0
falls back to pure server authority for an A/B.

## What is deliberately missing

**One room, no lobby.** Everyone lands in the same game, capped at 8. Rooms and
shareable codes are Phase 5.

**JSON frames.** ~1 KB per snapshot, ~20 KB/s per client. Fine for small rooms;
the flat number arrays in `shared/net/protocol.ts` are already the layout a
binary quantized encoder would want.

**No kill attribution.** A player knocked into the void credits whoever is first
in the map. Real credit needs last-touched tracking.
