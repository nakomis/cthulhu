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
| `apps/server/` | Fastify server: REST, WebSocket push, camera proxy, SQLite history, notifications. |
| `apps/web/` | React + Vite + Tailwind dashboard. |
| `infra/` | CDK. **Only** a GitHub CI role — Cthulhu has no AWS runtime. |
| `docker/` | Dockerfile and compose file for the deployment on Luke. |
| `docs/architecture/` | Architecture diagrams (drawio source, SVG auto-generated on commit). |

## The protocol

Documented by the community at <https://docs.opencentauri.cc/software/api/>,
written up from the Elegoo Discord.

> [!WARNING]
> Those docs describe the **Centauri Carbon, which is an FDM printer**. The
> Mars 5 Ultra is SLA. Expect nozzle and bed temperature fields to be absent or
> meaningless, `.goo` files instead of `.gcode`, and some status codes to
> differ. Treat the documentation as a hypothesis and verify against recorded
> traffic from the real machine.

Three fields are **misspelled in the wire format** and must be sent and parsed
exactly as-is: `CurrenCoord`, `RelaseFilmState` and
`MaximumCloudSDCPSercicesAllowed`. The client reads both the misspelled and the
corrected spelling, in case a firmware update quietly fixes them.

`MaximumVideoStreamAllowed` is **1**. This is a hard design constraint, not a
tuning parameter: the server holds the single upstream camera connection and
fans it out to browsers, and drops it when nobody is watching so the Elegoo app
still works.

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
