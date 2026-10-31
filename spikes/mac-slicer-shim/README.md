# mac-slicer-shim

A macOS app that SolidCraft's **Send to Slicer** can target, so a model can go
straight from CAD into the Cthulhu print pipeline (slice → trim → upload) rather
than via PrusaSlicer by hand.

This is a **spike**, kept under `spikes/` so it stays out of the pnpm workspace
globs (`packages/*`, `apps/*`, `infra`): it is a Swift macOS app, not a
TypeScript package, and is deliberately self-contained and not wired into the
monorepo build.

## Why an app, not a CLI

SolidCraft stores registered slicers as `.app` bundle *paths* with no argument
template (`~/Library/Application Support/SolidCraft/app.ron` → `custom_slicers`).
On macOS that means the hand-off goes through **LaunchServices**: the chosen app
receives the temp mesh as a *document to open* (an `odoc` Apple event), not as a
command-line argument. A bare script that reads `argv` never sees the file —
which is almost certainly why registering `DragonFruit.app` did nothing, while
PrusaSlicer (a real document-handling app) works.

So the shim must be a proper `.app` bundle that (a) declares in its `Info.plist`
that it opens the mesh type, and (b) implements the open-document handler.

## Step 1 — this probe (NoOp)

`Sources/main.swift` is an accessory app (no Dock icon, no window) that does
nothing but **log every path it is handed**, through every channel macOS might
use — `application(_:openFile:)`, `application(_:openFiles:)`,
`application(_:open:)` *and* `argv` — and sniffs each file (extension, size,
first 16 bytes, format guess). It accepts *any* document type (`public.item`) so
whatever SolidCraft sends is delivered.

Its job is to answer, for certain:
1. Does the Send-to-Slicer hand-off reach a custom app at all?
2. Which channel delivers the path (open-document event vs. argv)?
3. **What format/extension** does SolidCraft write? (STL? 3MF? OBJ?)

### Findings (31 Oct 2026)

All three answered by a real Send-to-Slicer run:

1. **Yes** — the hand-off reaches a registered custom app.
2. Via **`application(_:open:)`** (the `open(urls)` callback), **not** `argv`.
   This is why registering `DragonFruit.app` (argv-only) did nothing.
3. SolidCraft writes **3MF**, not STL — a `PK`-magic ZIP container at
   `~/Library/Caches/SolidCraft/slicer/<design>-<hash>.3mf`.

One bonus, worth knowing for step 2: **Send-to-Slicer bakes the marked print
face into the mesh.** A dock body native `77.2 × 55.8 × 85` arrived as
`85 × 55.8 × 77.2` sitting on `min Z = 0` — rotated onto the side face marked
with Ctrl+B. (The MCP `export` does *not* do this; it writes model-space only.)
So step 2 inherits SolidCraft's orientation for free on flat-face parts;
deliberate tilts for awkward parts still need a trimesh pass. The dragonfruit
slicer takes STL, so step 2 needs a 3MF→STL step (trimesh does it in a line)
unless the slicer learns to read 3MF.

## Step 2 — the real thing (later)

Replace the NoOp body with: parse the mesh, run the dragonfruit slice + support
+ `trim_islands`, `cthulhu.sh upload` the result, and a proper display
(material/exposure picker, orientation note, progress). Starting a print stays a
separate, explicit step — never automatic.

## Build

```bash
./build.sh
```

Compiles `main.swift` with `swiftc`, assembles `build/CthulhuSlicerShim.app`, and
registers it with LaunchServices.

## Register in SolidCraft

Preferences → custom slicers → add `build/CthulhuSlicerShim.app` (or append its
path to `custom_slicers` in `app.ron`). Then mark a print face (Ctrl+B) and
**Send to Slicer → Cthulhu Slicer (probe)**.

## Watch it

```bash
tail -f ~/Library/Logs/CthulhuSlicerShim/received.log
```

Also goes to the unified log (Console.app, or
`log stream --predicate 'subsystem == "com.nakomis.cthulhu.slicer-shim"'`).

Quit the probe with `killall CthulhuSlicerShim`.
