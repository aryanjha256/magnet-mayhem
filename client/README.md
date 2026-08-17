# Magnet Mayhem — client

Renderer, input, and debug UI. Runs the simulation locally in solo mode; renders
server snapshots online.

The question this build exists to answer is still the one from Phase 1:

> After five minutes of practice, can you reliably hit the thing you're aiming at?

```bash
npm install        # from the repo root — this is an npm workspace
npm run dev        # http://localhost:5173
npm run smoke      # headless physics checks, no browser
npm run typecheck
```

**Multiplayer:** run `npm run serve` too, then open two tabs at
`http://localhost:5173/?online` — keyboard in one, gamepad in the other. See
[../server/README.md](../server/README.md) for the netcode model. Online the
client runs no physics at all: the same `SimWorld` becomes a *view* whose
transforms are overwritten by server snapshots, so the renderer and HUD cannot
tell the two modes apart.

## Controls

| | |
|---|---|
| `WASD` | move (camera-relative, camera never rotates) |
| `Mouse` | aim — the magnet is a cone, not a sphere |
| `Hold RMB` | attract (momentary) |
| `Hold LMB` | repel (momentary) |
| `Q` / `E` | **toggle** attract / repel |
| `Esc` | release the toggle |
| `Space` | dash |
| `R` | reset the arena |

### Gamepad

| | |
|---|---|
| Left stick | move — deflection is a throttle, so you can walk slowly |
| Right stick | aim |
| `LT` / `RT` | attract / repel, **analog** |
| `LB` / `RB` | same, digital (for pads whose triggers aren't analog) |
| `A` / `Cross` | dash |
| `Start` / `Select` | reset |

Browsers hide gamepads until the page has seen one button press, so a freshly
connected pad reports nothing until you touch it. The HUD shows a live axis and
trigger readout whenever one is connected — useful when a pad maps oddly.

Merging is per-channel, not wholesale: an idle stick never suppresses WASD, and
you can steer with the stick while aiming with the mouse. Triggers beat keys,
because a trigger can express "slightly on" and a key cannot — falling back
mid-squeeze would snap the force to full.

**Why Q/E latch instead of hold.** On Linux, libinput's *disable-while-typing*
switches the touchpad off while a letter key is held — and key auto-repeat keeps
it off — so "hold Q and move the cursor to aim" is physically impossible on a
laptop. No amount of DOM work fixes that; the page never sees the pointer events
because the pointer never moves. Toggling frees the hand.

> **Playtesting on a laptop:** this affects `WASD` too, so moving and aiming at
> the same time does not work with the setting on. Tested: even a touch already
> in progress is cancelled the moment a key goes down, so there is no
> keep-your-finger-planted workaround. Turn it off before playing:
> ```bash
> gsettings set org.gnome.desktop.peripherals.touchpad disable-while-typing false
> ```

Pressing one polarity turns the other off, so attract → flip → repel is a single
keypress. Mouse and keyboard are tracked independently: a latch survives a mouse
click, and releasing a mouse button can't clear a latch.

Holding attract and repel together (only reachable via the mouse) cancels to
zero force. The HUD shows the current polarity, since a latch means the magnet
can be running with nothing held down.

## The one rule that matters

Magnet force is **equal and opposite**: `+F` on the target, `−F` on you.
Acceleration is `F/m`, so the mass ratio decides who actually moves.

- Light ball (1.2 kg) → the ball flies at you.
- Heavy ball (14–26 kg) → you both move.
- Giant crate (70 kg) → *you* fly at the crate.

That single line in `applyMagnet` is both the weapon and the grappling hook.
`reactionScale` in the tuner turns it off if you want to feel the difference.

## Layout

```
@magnet/shared    a workspace package, compiled by client AND server
├── sim/        the game. imports nothing from three.js.
│   ├── World.ts      fixed-timestep tick, N players, consumes only Inputs
│   ├── magnet.ts     the force curve — pure functions
│   ├── arena.ts      body layout as data
│   ├── Dummy.ts      practice opponents
│   ├── tunables.ts   every number worth arguing about
│   ├── input.ts      the Input struct
│   ├── types.ts      entity state
│   └── rng.ts        seeded PRNG
└── net/
    └── protocol.ts   the wire format, shared so it cannot drift

src/
├── net/        Connection + SnapshotBuffer (interpolation)
├── render/     reads sim state, owns none of it
├── input/      raw device state -> Input
│   ├── InputSource.ts    keyboard + mouse (evented)
│   ├── GamepadSource.ts  gamepad (polled)
│   ├── MagnetLatch.ts    Q/E toggle state machine
│   └── buildInput.ts     merges all of the above into one Input
├── debug/      live tuner + HUD
└── main.ts     wires the three together
```

## Four constraints that keep a server possible later

None of these cost anything now; all of them are painful to retrofit.

1. **`sim/` never imports a renderer.** `npm run smoke` runs the whole
   simulation under plain Node with no DOM. If that breaks, the layering broke.
2. **Fixed timestep, integer ticks.** `main.ts` owns wall-clock time; the sim
   only knows `tick`. Reconciliation is defined in terms of tick numbers, so
   without them there is nothing to reconcile against.
3. **Inputs are a flat serializable struct.** `Input` is already the packet.
   The sim reads nothing else — no mouse, no keyboard, no `performance.now()`.
4. **No hidden non-determinism.** Seeded `Rng`, never `Math.random()`; never
   `Date.now()`. The smoke test asserts 400 ticks reproduce bit-for-bit.

Deliberately *not* built yet: any network abstraction, serialization, or
client/server split. Those get guessed wrong when there's no server to test
against.

## Rounds

A match is a series of rounds; first to `roundsToWin` (3) takes it.

- **Elimination.** Fall during a round and you are out until the next one. This
  is what gives the magnet stakes — before it, a knockout cost five seconds.
- **Countdown.** Input is frozen for 2.5s at the start of each round, so nobody
  can shove through the bell.
- **Shrinking arena.** After a 15s grace the disc closes from 9m to 3m over 45s,
  which forces a conclusion. Two cautious players — and the bots are *very*
  good at not dying — would otherwise circle forever.
- **Timeout.** If the round clock runs out with several alive, the player
  nearest the middle takes it. Arbitrary, but deterministic and never a draw.

The arena is a disc rather than a square: ring-out on a square has awkward
corners, and the shrink wants a radius. Bots read the live radius, not a
constant, so they retreat as the floor closes in.

`new SimWorld(seed, { match: false })` gives the old endless sandbox, which is
what the isolated physics measurements use.

## Dummy players

Three opponents share the arena, each answering one question the single-player
sandbox could not:

| | | |
|---|---|---|
| grey | **inert** | can I fling another player off the edge at all? |
| purple | **grabber** | what does it feel like when something pulls back? |
| green | **opposer** | does opposing polarity make a tug-of-war, or mush? |

They are player-shaped in every way that matters — same 5 kg mass, same low
friction, same upright constraint — so flinging one is exactly as hard as
flinging a human will be.

**The tug-of-war works.** Attract the opposer and the two forces come out at
`−216.3 N` and `+216.3 N`: equal, opposite, exactly cancelling. Measured against
a control run where the same dummy is switched to inert, fighting back cuts how
far it gets dragged from 2.02 m to 0.71 m.

**Dummies fire a focused beam at you, not a cone.** This is the one place they
are not honest players, and it is deliberate. A cone this wide sprays every
nearby body, and the source eats a reaction from each — an opposer at default
settings picks up ~500 N of unbalanced recoil and launches itself off the arena
in under a second, long before you can feel what it was demonstrating. Real
players in Phase 4 call the same function without the focus argument.

That recoil is worth keeping in mind as a mechanic rather than a bug: **firing
your magnet into a crowd shoves you hard.** A cluster of balls is a launchpad.

The grabber pulses (40 ticks on, 55 off) and releases inside 3 m. A constant
pull just welds the pair together at contact range.

`world.setDummyBehavior(id, behavior)` swaps one at runtime.

## Tuning notes

Everything in the tuner writes straight into `TUNABLES`, which the sim re-reads
every tick — no reload needed.

**Falloff modes.** `smooth` is the default and the one worth tuning.
`inverseSquare` is included so you can feel why it's a bad default; `npm run smoke`
prints the curve:

```
mode             0.5m     1m     2m     4m     6m     8m    10m    12m
linear            431    413    375    300    225    150     75      0
smooth            413    378    313    200    113     50     12      0
inverseSquare     431    413     94     19      6      2      1      0
```

Inverse-square is nuclear at contact and effectively dead past 2 m — it reads as
broken rather than skillful, and it needs the `minDistance` clamp or the force
goes to infinity at contact.

**Player friction is 0.2, and the combine rule is `Min`.** Both halves matter.
Rapier's default rule is `Average`, which quietly averaged the player's 0.2
against the platform's 0.8 into an effective 0.5 — that's 65 N of friction
against a 55 N move force, and the player could not walk at all. `Min` means
each body's own friction governs, which is the intent: the player slides.

Gravity is -26 (≈2.6 g) for snappy arcade falls, so weight-driven friction is
larger than it looks. At μ=0.2 the player needs ~26 N just to break static
friction; `moveForce` is 90.

**Walking is capped at `maxSpeed`; magnet forces are not.** Being flung is
supposed to be the fast way across the arena. Measured: walking settles at
~7 m/s, while grappling the 70 kg crate peaks at ~16.5 m/s.

These numbers are the *optimistic* feel — they're tuned against a zero-latency
local sim. Expect to revisit them once objects arrive over a network.

## Known gap for later

With snapshot interpolation, remote objects render ~100 ms in the past, so the
ball you aim at is where it *was*. Most games hide this; this one can't, because
manipulating objects is the whole mechanic. The eventual fix is to locally
predict only the bodies inside your magnet radius and blend them back to server
truth on release. Not a Phase 1 problem, but it's why the feel numbers above
aren't final.
