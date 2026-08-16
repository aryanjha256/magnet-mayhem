# @magnet/shared

The simulation and the wire protocol. A private workspace package, imported by
both `client/` and `server/` as `@magnet/shared/sim/*` and `@magnet/shared/net/*`.

It ships raw TypeScript — `exports` points straight at `src/`, and consumers
compile it as part of their own build. No build step, no emitted artifacts, and
no way for the client and the server to end up on different versions of the sim.

**Why this is a package and not a path alias.** `shared/` has a real runtime
dependency: `World.ts` imports `@dimforge/rapier3d-compat`. Under an alias,
imports are rewritten to file paths and resolution walks up from `shared/src/`
to whatever happens to be hoisted at the repo root — so rapier had to be
declared by *both* consumers on shared's behalf, and nothing enforced it.
Delete it from one manifest and things keep working until hoisting changes.
As a package, shared declares rapier itself, once, and npm guarantees it.

**Nothing in here may import Three.js, the DOM, or a WebSocket.** `npm run smoke`
executes the whole simulation under plain Node with no browser present; if that
stops working, the layering broke.
