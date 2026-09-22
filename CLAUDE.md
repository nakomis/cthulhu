# Cthulhu

A standalone print server for the Elegoo Mars 5 Ultra resin printer, speaking
SDCP over the LAN. Web UI plus REST API, deployed as Docker on Luke.

## The single most important thing

**The community SDCP documentation describes the Centauri Carbon, an FDM
printer. This is an SLA printer.** Do not write a status parser against those
docs and assume it is right. Record real traffic from the machine first and
keep the capture as a test fixture. Temperature fields are expected to be
absent or meaningless, files are `.goo` not `.gcode`, and status codes may
differ.

Three fields are misspelled in the wire format and must be reproduced exactly:
`CurrenCoord`, `RelaseFilmState`, `MaximumCloudSDCPSercicesAllowed`. Never
"correct" them. `readMisspelled()` in `packages/sdcp` reads either spelling.

`MaximumVideoStreamAllowed` is **1**. The camera proxy must hold one upstream
connection and fan it out, and drop it when nobody is watching, or the Elegoo
app stops working.

## Stack

- pnpm workspace, Node 25, TypeScript 7 throughout
- `packages/sdcp` — protocol client, no web or storage dependencies
- `apps/server` — Fastify
- `apps/web` — React 19, Vite, Tailwind 4
- `infra` — CDK, GitHub CI role only
- Biome for lint/format; Vitest everywhere except `infra`, which uses Jest

### Toolchain gotchas worth knowing

- **TypeScript 7 is the Go-based native compiler and does not expose the JS
  compiler API.** `ts-jest` and `ts-node` both break on it. `infra` therefore
  transforms with `@swc/jest` and runs CDK through `tsx`, not `ts-node`.
- **Always give `tsc` an `outDir`.** Without one it emits `.js` and `.d.ts`
  beside the sources, where Biome lints them and Vitest runs the stale `.js`
  copies of test files *alongside* the real `.ts` ones — silently doubling the
  test count.
- **Keep `allowBuilds` in `pnpm-workspace.yaml` complete before running
  install.** pnpm appends its own `set this to true or false` placeholder for
  any blocked build script, which duplicates the key and makes the file invalid
  YAML.
- Biome needs `css.parser.tailwindDirectives` for Tailwind 4's `@theme`.

## Repository layout

See the table in [README.md](README.md#repository-layout).

## AWS

- Sandbox: `AWS_PROFILE=nakom.is-sandbox` (975050268859)
- Production: `AWS_PROFILE=nakom.is-admin` (637423226886)

Cthulhu has **no AWS runtime**. The only stack is `GithubCiStack`, whose role
exists so CI can reach the shared deployment-version tracker at
`api.infra.nakomis.com`. The tracker lives in the prod account, so the sandbox
role is a cross-account caller and needs its own `execute-api:Invoke` identity
policy — without it `compute-version` silently falls back to bumping
0.1.0 → 0.1.1 on every merge.

This repo presents the **immutable** OIDC subject form
(`repo:nakomis@1488244/cthulhu@1381430098`). The trust policy accepts both that
and the older name-only form; do not "tidy" the list down to one.

## Testing

```bash
pnpm lint && pnpm -r typecheck && pnpm -r test && pnpm -r build
```

70% coverage minimum.

## Deployment

Docker on Luke, port 9120 (Plane holds 9110), behind Leia's nginx with mTLS at
`cthulhu.home.nakomis.com`. **The deployment config lives in the `home-servers`
repo, not here** — that is a separate PR.

Luke is an old HP ProLiant N40L with **no AVX**. Check anything native
(`better-sqlite3`, `sharp`) actually runs on the target, not just in CI.

UDP broadcast discovery needs `network_mode: host` *and* the printer on Luke's
subnet. If the printer's WiFi puts it on a different VLAN, `PRINTER_IP` is the
only route. Both paths are built deliberately.

## Work tracking

Plane project **CTHU** at <https://plane.home.nakomis.com>. Branch names and PR
titles carry the ref, e.g. `feat(sdcp): discovery (CTHU-2)`.

## Architecture diagrams

Source: `docs/architecture/cthulhu.drawio` — SVG auto-regenerated on commit by
`.githooks/pre-commit`.

```bash
git config core.hooksPath .githooks
```
