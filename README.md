# GIS Browser

[![Build](https://github.com/ShinobiFPV/gis-browser/actions/workflows/build.yml/badge.svg)](https://github.com/ShinobiFPV/gis-browser/actions/workflows/build.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Ask for a Canadian boundary in plain language. Get back a clean GeoJSON or SVG outline
from official open data, with its source, licence and vintage attached.

Built for broadcast graphics — the case it is shaped around is an artist on deadline who
needs the outline of a federal riding, a First Nation reserve or a census subdivision, and
needs it to be *right*, because a wrong boundary on air costs far more than a click.

![Search, preview and export](docs/screenshots/search-and-export.png)

---

## The problem

Canadian boundary data is all published openly, and almost none of it is easy to get.
It is spread across Statistics Canada, Elections Canada, NRCan, thirteen provincial
portals, ArcGIS Hubs and CKAN instances. Each uses a different API, a different
projection, a different idea of what a field should be called, and its own name for the
same place. Finding "Parry Island First Nation" means knowing it is filed as
*Parry Island 16* in one source and *Wasauksing* in conversation.

GIS Browser indexes all of it by name, then fetches only the geometry you actually ask
for.

## Core architectural decision: index everything, fetch geometry on demand

This drives the whole design. The local database is a **searchable catalog with a geometry
cache**, not an offline mirror of Canada.

**Tier A** — queryable services (ESRI FeatureServer, OGC WFS). Harvest names, attributes
and a bounding box. No geometry. When you export a boundary, its geometry is fetched from
the source and cached permanently. The cache warms around whatever your newsroom actually
uses.

**Tier B** — bulk files. There is no per-feature interface, so the only way in is to take
the whole archive. These are explicitly user-triggered, the size is shown before the
download starts, and geometry is stored at index time — so those boundaries export with
no network at all.

A full harvest of the current registry indexes **90,495 features** and **203,482 search
aliases** from 44 sources, in a SQLite file that stays in the low hundreds of megabytes.

---

## Screenshots

### Search → preview → export

Three local matching passes, a map preview, and an export pane that tells you what
simplification actually did before you write the file.

![Search and export](docs/screenshots/search-and-export.png)

### First run

A fresh install has sources registered but nothing indexed, so it explains itself and
offers a starter harvest. Bulk downloads are excluded from every plan and it says so.

![First-run wizard](docs/screenshots/first-run.png)

### Source discovery

Crawls ArcGIS Hub and CKAN portals for boundary layers, classifies them, checks each
endpoint is live, and stages them for review. Nothing enters the catalog without you
accepting it — every concern is listed, never collapsed.

![Discovery](docs/screenshots/discovery.png)

### Settings

API key and model, inline. No modal dialogs anywhere in the search-to-export path.

![Settings](docs/screenshots/settings.png)

### Example output

Four provinces exported to SVG at 8% retention, in Statistics Canada Lambert. The curved
northern edge is the projection doing its job — unprojected it would be a straight
parallel. Shared borders stay shared.

![Example SVG export](docs/screenshots/example-export.png)

---

## How search works

Type a request in plain language. It is understood **without any network call**:

1. **Parse** — a keyword parser pulls out the place name, boundary type, province and
   vintage. `"Give me the outline shape for Parry Island First Nation"` becomes
   `parry island` + type `indian_reserve`.
2. **Match** — three passes over an SQLite FTS5 index of every name and alias: exact
   phrase, then a looser pass for extra words, then bounded-Levenshtein fuzzy matching
   for typos, prefiltered by trigram.
3. **Rank** — scored on name similarity, source authority for that boundary type, alias
   quality, type and jurisdiction agreement, and vintage.

**The top five are always shown, with map thumbnails. Nothing is ever auto-exported**,
however confident the match.

Adding an Anthropic API key layers Claude over both ends: it parses the request and
re-ranks the candidates. Both are optional and both degrade independently — if the key is
missing, rate-limited or the reply is malformed, the local resolver answers and the UI
says so. **Geometry is never sent to the model**, only names, types, sources and a
handful of attributes.

## How export works

**GeoJSON** — RFC 7946. WGS 84 lon/lat with no `crs` member at any depth, right-hand-rule
winding (ESRI serves the reverse, so nearly everything needs rewinding), bbox at feature
and collection level, six-decimal coordinates. Every feature carries a `_provenance`
block: source URL, licence, attribution, vintage, retrieval times and exactly what
simplification did. It is written per feature, not per file, so a boundary dragged into
another document keeps its history.

**SVG** — projected through proj4 before fitting to the canvas. One `<g id>` per feature
so Illustrator names the layers, all rings of a feature in a single path with
`fill-rule="evenodd"` so holes stay holes.

**Simplification** — topology-preserving Visvalingam via mapshaper. Every feature in one
export is handed over as a single dataset, so two ridings that share a border share the
same simplified arc. Measured on real data: exporting Ontario, Quebec, Manitoba and
Saskatchewan together, Ontario and Quebec share 484 border vertices *exactly*. Simplified
separately, the two sides diverge and a hairline of background shows through the seam.

The before/after vertex count runs the real simplification rather than estimating, and
anything lost — a dropped island, an enclave, generalisation the source applied — is
reported with its size, so you can judge whether to care.

---

## Getting started

### Install

From [Releases](../../releases):

| Platform | File |
|---|---|
| Windows x64 | `GIS Browser-<version>-setup.exe` |
| macOS Apple silicon | `GIS Browser-<version>-arm64.dmg` |
| macOS Intel | `GIS Browser-<version>-x64.dmg` |

**Both builds are unsigned**, and the two platforms handle that differently.

*Windows* — SmartScreen warns on first run until the installer builds reputation. Choose
*More info → Run anyway*.

*macOS* — Gatekeeper is stricter. A downloaded unsigned app is quarantined, and macOS
reports that it **"is damaged and can't be opened"**, which is misleading: the app is
fine, it simply is not notarized. After dragging it to Applications, clear the quarantine
attribute:

```bash
xattr -dr com.apple.quarantine "/Applications/GIS Browser.app"
```

Signing and notarizing both require certificates this project does not have.

On first launch the wizard offers a starter harvest. The essential set (~22 sources —
ridings, provinces, reserves, municipalities, census subdivisions) takes a few minutes.
Bulk downloads are never started for you.

### Build from source

Requires Node 20+. Each installer must be built on its own platform — electron-builder
rebuilds the native module against the host, so there is no cross-compiling here.

```bash
npm install          # postinstall rebuilds better-sqlite3 for Electron
npm run dev          # run in development
npm test             # 415 tests
npm run typecheck    # strict TypeScript, both tsconfigs
npm run lint         # eslint, zero warnings allowed
npm run dist:win     # NSIS installer into release/  (on Windows)
npm run dist:mac     # arm64 + x64 disk images into release/  (on macOS)
npm run icon         # regenerate build/icon.ico (pure Node, no image toolchain)
```

### Continuous integration

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs typecheck, lint and the
full test suite on Linux, then builds the Windows installer and the macOS disk images in
parallel and **smoke-tests each packaged binary** — `--smoke` opens the catalog, runs every
migration, seeds the registry and exits, without ever creating a window.

That last step is the one that matters. Packaging can silently break exactly one thing:
better-sqlite3 is a native module and has to be unpacked from the asar to load. A broken
unpack builds cleanly, installs cleanly, and then dies on the first query. Running the
packaged binary is the only way to catch it.

It also asserts the exact number of native binaries that survived packaging — one on
Windows, two on macOS — because the builder config strips the prebuilds for other
platforms and an over-matching filter would remove SQLite entirely.

Every push to `main` uploads installer artefacts. Pushing a `v*` tag publishes a release.

### Headless CLI

Everything the UI does can be driven from a terminal, which is how most of this was
verified:

```bash
electron out/main/cli.js --list                              # the source registry
electron out/main/cli.js --id 12                             # harvest one source
electron out/main/cli.js --find "Parry Island First Nation"  # search + fetch geometry
electron out/main/cli.js --find "Nunavut" --export svg --retention 5
electron out/main/cli.js --feature 3623 --feature 3624 --export geojson
electron out/main/cli.js --discover "Manitoba electoral divisions"
electron out/main/cli.js --candidates                        # review what discovery found

npm run inspect                                              # catalog invariants
```

---

## Sources

44 registered sources, all verified with a live request before being hardcoded. 37 Tier A,
7 Tier B.

| Publisher | Covers |
|---|---|
| Statistics Canada | Provinces, census divisions and subdivisions, CMAs, census tracts, population centres, economic regions, dissemination areas |
| Elections Canada | Federal electoral districts, every representation order 2003–2025 |
| NRCan Surveyor General | Aboriginal Lands of Canada — reserves, settlements, treaty lands |
| Ontario LIO / GeoHub | Provincial ridings, municipalities, First Nation reserves, parks |
| BC Data Catalogue (WFS) | Provincial ridings, municipalities, regional districts, parks |
| Elections Alberta | 87 electoral divisions |
| Elections Saskatchewan | 61 provincial constituencies |
| Government of Yukon | 21 territorial electoral districts |
| Government of Newfoundland and Labrador | 40 provincial districts |
| Natural Earth | Countries, lakes and rivers, as context behind a Canadian boundary |

Boundary types are a **closed vocabulary** of 40 values, shared by the database CHECK
constraint, the LLM enum and the UI filters, so they cannot drift apart. 25 of them are
represented in a full harvest of the current registry.

### Discovery

The crawlers search ArcGIS Hub and the federal, BC and Québec CKAN portals. This is
deliberately a proposal system, because of what those catalogs actually return: a search
for "provincial electoral districts" puts a city's five-riding municipal extract on the
first page beside a genuine 40-riding government layer, under a nearly identical title.

Candidates are classified, checked against a live request, and scored with every concern
spelled out — *"covers 0.1% of Ontario, but a provincial electoral district layer should
span the whole jurisdiction"*, *"Yukon has 1 federal seat but this holds 21 features"*,
*"published by an individual account rather than an organisation"*. You accept or reject.

---

## Stack

Electron 43 · React 19 · TypeScript 5.9 (strict) · Vite 7 via electron-vite ·
better-sqlite3 (FTS5 + R-tree) · proj4 · mapshaper · maplibre-gl · shapefile + yauzl ·
`@anthropic-ai/sdk`

**No GDAL, ogr2ogr, SpatiaLite, GEOS or any system binary.** Pure JS and WASM, so the app
ships as one installer. The app icon is even generated by a pure-Node rasteriser
(`npm run icon`) rather than an image toolchain.

```
src/
  main/        IPC, window, Anthropic client, safeStorage key handling, export, discovery
  harvester/   utilityProcess: HTTP, catalog clients, bulk ingest, normalisation
  resolve/     parsing, fuzzy matching, ranking — the search layer, heavily tested
  export/      GeoJSON, SVG, simplification, provenance, winding
  db/          schema, migrations, seeded source registry
  renderer/    React UI, four panes
  shared/      taxonomy, IPC contract, projections — the seams between processes
```

~12,900 lines of source, ~4,100 of tests, 7 append-only schema migrations.

### Security and key handling

The Anthropic API key is entered in Settings, encrypted with Windows DPAPI via Electron's
`safeStorage`, and stored outside the catalog. It never reaches the renderer, is never
written to the database, and is never logged. Every Claude call originates in the main
process.

Harvested attribute values are third-party text that ends up in a prompt, so the ranking
prompt marks the candidate list as data and instructs the model not to follow instructions
found inside it.

---

## Known limitations

Stated plainly, because the point of this app is not guessing:

- **The successful Claude path has never run against the live API.** There is no API key
  on the development machine. The failure paths were verified end to end against the real
  endpoint with a deliberately invalid key; the success path is covered by 45 tests with
  an injected client.
- **The SVG has never been opened in Illustrator or After Effects.** Geometry, projection
  and canvas fit are verified by rendering; Adobe's handling of the group and layer naming
  is not.
- **Seven jurisdictions have no provincial ridings yet** — MB, QC, NB, NS, PE, NT, NU.
  The crawlers can find them; they are not seeded because they have not been verified to
  the same standard as the rest.
- **Seven Elections Canada sources on `maps-cartes.services.geo.ca` return HTTP 403**
  host-wide and cannot be harvested. The Tier B shapefile fallback covers the 2023 ridings
  completely, which is why that redundancy was seeded.
- **The installer is unsigned.** Signing needs a code-signing certificate.
- **The macOS build has never been run by a human.** CI builds both disk images on a real
  macOS runner and smoke-tests the arm64 bundle — it launches, opens the catalog, runs
  every migration and seeds the registry — but nobody has installed the `.dmg`, clicked
  through the UI, or exercised Keychain-backed key storage. The Windows build has.
- **No Linux target.** Nothing in the codebase prevents one; it simply is not built.

## Licence

The application is **MIT licensed** — see [LICENSE](LICENSE). Use it, fork it, ship it.

**The boundary data is a separate matter and is not the application's to license.** Every
source carries its own terms, set by the body that published it. Those terms are recorded
in the source registry, shown in the app, and written into the `_provenance` block of
every file you export — alongside the source URL, vintage and retrieval date, so a
boundary can always be traced back to where it came from.

Several sources publish under the Open Government Licence – Canada. Several declare
nothing usable at all, and those are flagged as *unconfirmed* rather than quietly assumed
to be open. An unconfirmed licence is not permission — check the terms of the specific
source before publishing or broadcasting anything derived from it.

See [NOTICE.md](NOTICE.md) for the full picture on data licensing.

© 2026 ShinTech Electronics
