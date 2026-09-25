# Cthulhu — a standalone print server for the Elegoo Mars 5 Ultra

<img src="docs/logo.png" alt="Cthulhu logo" width="200" align="right"/>

Imagine an [Octopus](https://octoprint.org/) rising up from a vat of goo.

In FDM printing, you're driving G-code over a serial link to
Marlin-style boards - [OctoPrint](https://octoprint.org/) is the way to go. A resin printer is a
very different beast; it's a layer-image machine with a Chitu
mainboard, so there is nothing for OctoPrint to talk to. What the printer *does*
expose is **SDCP** (Smart Device Control Protocol) over the LAN — and that is
enough to do the bits we really need.

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=cthulhu)

## Table of Contents

<!-- toc -->

- [Repository Layout](#repository-layout)
- [The protocol](#the-protocol)
- [What the real printer taught us](#what-the-real-printer-taught-us)
- [The camera](#the-camera)
- [Print history and time-lapse storage](#print-history-and-time-lapse-storage)
  * [Migrating history from SQLite to Postgres](#migrating-history-from-sqlite-to-postgres)
- [Development](#development)
  * [Running against a printer](#running-against-a-printer)
- [Deployment](#deployment)
- [Architecture Diagrams](#architecture-diagrams)
- [Licence](#licence)
- [Support](#support)

<!-- tocstop -->

## Repository Layout

| Path | What it is |
|---|---|
| `packages/sdcp/` | The SDCP protocol client. Deliberately free of web and storage concerns, so it is independently testable and publishable on its own merits. |
| `packages/camera/` | Camera plumbing shared by both apps: one upstream shared between viewers, and RTSP to MJPEG through ffmpeg. |
| `packages/fake-printer/` | A fake Mars 5 Ultra for tests and local development, shaped from real captures. |
| `apps/server/` | Fastify server: REST, WebSocket push, camera proxy, print history (SQLite or Postgres), notifications. |
| `apps/camera/` | The camera transcoder, run off Luke: pulls the printer's RTSP stream and serves it as MJPEG over HTTP, and assembles time-lapses. |
| `apps/web/` | React + Vite + Tailwind dashboard. |
| `infra/` | CDK. **Only** a GitHub CI role — Cthulhu has no AWS runtime. |
| `docker/` | `Dockerfile` (the server) and `camera.Dockerfile` (the camera service), plus the compose file for the deployment on Luke. |
| `docs/architecture/` | Architecture diagrams (drawio source, SVG auto-generated on commit). |

## The protocol

SDCP V3.0.0, specified by CBD-Tech (Chitubox) for resin printers:
<https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0>.

> [!WARNING]
> The spec is generic across Chitubox boards, and the Mars 5 Ultra departs
> from it in ways that matter - see
> [What the real printer taught us](#what-the-real-printer-taught-us). Where
> the spec and a recorded capture disagree, the capture wins. The community
> docs at docs.opencentauri.cc describe the Centauri Carbon, an FDM printer,
> and are not a reliable guide to this one.

Three fields are **misspelled in the wire format** and must be sent and parsed
exactly as-is: `CurrenCoord`, `RelaseFilmState` and
`MaximumCloudSDCPSercicesAllowed`. The client reads both the misspelled and the
corrected spelling, in case a firmware update quietly fixes them.

`MaximumVideoStreamAllowed` is **2** on the real printer. The server holds a
single upstream camera connection and fans it out to browsers, and drops it
when nobody is watching, so the second slot stays free for the Elegoo app.

## What the real printer taught us

Found against an Elegoo Mars 5 Ultra, firmware V1.5.0, on 23–24 September
2026. The captures are in `packages/sdcp/fixtures/`, and
`real-capture.test.ts` checks the parser against every frame of a real print.

| Finding | Consequence |
|---|---|
| `S-File-MD5` is a **form field**, not a header | Sent only as a header, every upload is accepted packet by packet with `success:true`, then fails its MD5 check and is deleted |
| A rejected upload is reported **only** as `sdcp/error` (`ErrorCode` 1 MD5, 2 format) | An upload has succeeded only once the printer lists it in `/local`: `confirmUploaded()` |
| While it checks a file, the printer holds it as `/local/<uuid>_<name>` and reports machine status `[2, 8]` | A listing taken then shows a file that is about to vanish |
| The camera is RTSP **over UDP only**; asked for TCP it answers "Nonmatching transport" | ffmpeg uses `-rtsp_transport udp+tcp` |
| `MaximumVideoStreamAllowed` is **2**, and the printer's count of enabled streams can stick at the limit with nobody watching | It then refuses Cmd 386 with Ack 1 while its RTSP server keeps serving: cthulhu falls back to the last URL |
| `DevicesStatus` (film health and friends) comes only in **attributes**, without `XMotorStatus` | The store takes it from whichever frame has it |
| Status has no `TempOfBox`, `CurrenCoord`, `PrintScreen` or `PreviousStatus` | Parsed as optional, as ever |
| `CurrentTicks` / `TotalTicks` are milliseconds | The touchscreen's 2 h 14 m matched |
| A normal print ends 7 (Stopping) → 9 (Complete) | Status 7 with no layers left is labelled "Finishing" |
| Uploads run at about 100 KB/s over the printer's WiFi | 13 MB takes about two and a half minutes |
| The printer runs a web server (Mongoose) on port 3030 that serves its filesystem **by path**, with Range support: `/media/mmcblk0p3/` is internal storage (SDCP's `/local`), `/media/sda1/` the USB stick | Previews and details are read from each file's own header; the current print's file is fetched to draw its layers. Downloads are fast - seconds for 13 MB |
| That web server is unauthenticated and serves everything, **including the WiFi password in plain text** (`/media/mmcblk0p1/wlan_entry`) | cthulhu only ever fetches `.goo`/`.ctb` under the two storage roots. The real fix is network isolation |
| Cmd 321 works for the print in progress, giving the file's full path (`TaskName`) and a 400×300 thumbnail URL | The Status panel's picture, for however the print was started |
| `.goo` layers: 0x55, runs, a checksum (bitwise NOT of the byte sum). A run's length keeps its **low** 4 bits in the lead byte | `packages/goo`, proven against every layer of a real file |

## The camera

The printer's camera is H.264 over RTSP; a browser `<img>` wants MJPEG. The
decode and re-encode is the heaviest thing cthulhu does, and too much for
Luke's two 1.5 GHz cores, so it runs elsewhere: `apps/camera` on phi for now,
Rey eventually.

```text
browser ──mTLS──> Leia ──> cthulhu on Luke ──HTTP MJPEG──> apps/camera on phi ──RTSP/UDP──> printer
                              │                                                             ▲
                              └──────────── Cmd 386: stream on / off ───────────────────────┘
```

- cthulhu points `CAMERA_URL` at the transcoder, and still owns the SDCP
  side: it turns the printer's stream on before connecting and off when the
  last browser leaves. The transcoder knows nothing about SDCP.
- The transcoder stops ffmpeg when nobody is connected, so it costs nothing
  while idle.
- Leave `CAMERA_URL` empty and cthulhu transcodes locally, as before. It
  works, at the cost of Luke's CPU.
- The printer stamps its frames about 11× too fast (it advertises 30/11 fps),
  so ffmpeg is told to time frames by arrival: `-use_wallclock_as_timestamps`.
  Anything timed by the printer's clock is wrong.

```bash
PRINTER_IP=172.29.0.37 pnpm --filter @cthulhu/camera-service start   # http://localhost:9121/video
```

The camera service runs natively today, but `docker/camera.Dockerfile` builds
it as a container - no native dependencies, so it is genuinely multi-arch
(`linux/amd64` and `linux/arm64`), unlike the server image. Two envs matter
only in that container:

- `RTP_PORT_MIN` / `RTP_PORT_MAX` — a fixed range of local UDP ports for
  ffmpeg's RTP receive, both or neither. Docker Desktop on macOS cannot use
  host networking, and a bridged container's ephemeral RTP ports are not
  reachable from outside at all unless every one is published, so phi needs
  `-p 50000-50009:50000-50009/udp` with a matching `RTP_PORT_MIN=50000
  RTP_PORT_MAX=50009`. Harmless, and unnecessary, under Linux host networking
  (Luke, Rey).
- `TIMELAPSE_DIR` / `TIMELAPSE_FPS` — see
  [Print history and time-lapse storage](#print-history-and-time-lapse-storage).

## Print history and time-lapse storage

The server is moving off Luke into Docker on phi, and later Rey, but its
storage stays on Luke: print history in Postgres, finished time-lapses on a
Samba share. SQLite must never live on a network share — WAL and locking do
not work over Samba/NFS — which is why history has two implementations. See
CTHU-15 and CTHU-16.

- **History**: SQLite (`DATABASE_PATH`, default `/data/cthulhu.sqlite`) is the
  default, and fine for development or a deployment where the server and its
  data are on the same box. Set `DATABASE_URL` (a Postgres connection string,
  e.g. `postgres://user:pass@luke:5432/cthulhu`) to use Postgres instead - the
  table is created on the way in if it does not exist yet. Both
  implementations share the same semantics: a restart mid-print never creates
  a duplicate open row for the same task, and `finishPrint` always closes
  whichever row is still open.
- **Time-lapse archive**: set `TIMELAPSE_ARCHIVE_DIR` to a directory - a Samba
  share mounted into the container - and the server periodically (every 60s,
  and promptly after a print finishes) moves every `ready` time-lapse off the
  camera service and onto it: downloaded to `<id>.mp4.part`, renamed to
  `<id>.mp4`, a `<id>.json` written alongside it, and only then is the camera
  service asked to delete its own copy (`DELETE /timelapse/:id`). A failure at
  any point - the share or the camera service unreachable - just retries next
  tick; the camera service's copy is never deleted before the archive's own
  copy exists on disk, so there is always at least one copy somewhere. Leave
  it unset and time-lapses stay exactly where they are today, on the camera
  service's own disk.

### Migrating history from SQLite to Postgres

A one-off CLI, built alongside the server:

```bash
node apps/server/dist/migrate-history.js \
  --sqlite /mnt/data/cthulhu/cthulhu.sqlite \
  --database-url postgres://user:pass@luke:5432/cthulhu
# or: SQLITE_PATH=... DATABASE_URL=... node apps/server/dist/migrate-history.js
```

Idempotent, so it is safe to run more than once - a second pass while the old
and new servers overlap, say. A row with a `task_id` already in Postgres is
skipped; a row with no `task_id` (older prints, from before every print
reliably got one) is matched and skipped by its `started_at` timestamp
instead, since that is all such a row has to identify it by.

## Development

Requires Node 25 and pnpm (both pinned — see `.tool-versions` conventions in
`~/CLAUDE.md` and `packageManager` in `package.json`).

```bash
pnpm install
pnpm lint          # Biome
pnpm -r typecheck
pnpm -r test       # Vitest, except infra which uses Jest
pnpm -r build
```

### Running against a printer

Discovery uses a UDP broadcast, which does not cross subnets and which Docker's
bridge networking eats entirely. Both routes to the printer are supported:

```bash
PRINTER_IP=192.168.1.2 pnpm --filter @cthulhu/server dev   # pinned, always works
DISCOVERY_ENABLED=true pnpm --filter @cthulhu/server dev   # needs the same subnet
```

## Deployment

Docker on Luke, behind Leia's nginx at `cthulhu.home.nakomis.com`, on port 9120.
The deployment configuration itself lives in the **`home-servers`** repository,
not here.

Every service behind Leia requires a client certificate, so viewing the
dashboard on a phone means installing one via cert-portal. Print-finished
notifications go via Pushover, which needs no certificate.

> [!IMPORTANT]
> **On iOS, open the dashboard in Safari, not Chrome.** Chrome on iOS does not
> present client certificates from the system keychain — it uses its own
> networking stack and will not offer the cert. The failure is a bare TLS
> error with nothing to suggest the cause, so it looks like the server is
> broken rather than the browser being incapable. Safari works, and so does
> adding the dashboard to the home screen from Safari.

## Architecture Diagrams

`docs/architecture/cthulhu.drawio` is the source for the architecture diagram.
The SVG is auto-regenerated on commit by the pre-commit hook in
`.githooks/pre-commit`.

To activate the hook after cloning:

```bash
git config core.hooksPath .githooks
```

## Licence

CC0 1.0 Universal. See [LICENSE](LICENSE).

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=cthulhu)
