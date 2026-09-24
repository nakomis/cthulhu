# Cthulhu — a standalone print server for the Elegoo Mars 5 Ultra

<img src="docs/logo.png" alt="Cthulhu logo" width="200" align="right"/>

OctoPrint, but only the bits I want, for a resin printer.

OctoPrint itself is no use here: it drives G-code over a serial link to
Marlin-style boards. A resin printer is a layer-image machine with a Chitu
mainboard, so there is nothing for OctoPrint to talk to. What the printer *does*
expose is **SDCP** (Smart Device Control Protocol) over the LAN — and that is
enough to rebuild the useful half of OctoPrint from scratch.

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=cthulhu)

## Table of Contents

<!-- toc -->

- [Repository Layout](#repository-layout)
- [The protocol](#the-protocol)
- [What the real printer taught us](#what-the-real-printer-taught-us)
- [The camera](#the-camera)
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
| `apps/server/` | Fastify server: REST, WebSocket push, camera proxy, SQLite history, notifications. |
| `apps/camera/` | The camera transcoder, run off Luke: pulls the printer's RTSP stream and serves it as MJPEG over HTTP. |
| `apps/web/` | React + Vite + Tailwind dashboard. |
| `infra/` | CDK. **Only** a GitHub CI role — Cthulhu has no AWS runtime. |
| `docker/` | Dockerfile and compose file for the deployment on Luke. |
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
