# Claude Code Build Prompt — GIS Browser

Paste everything below into Claude Code as the opening prompt.
Project root: `C:\Users\billk\Projects\ShinTech\GIS-Browser`

---

## Project

**GIS Browser** — a Windows desktop app (Electron) that lets a broadcast graphics artist
type a plain-language request like **"Give me the outline shape for Parry Island First
Nation"** or **"the federal riding of Parry Sound—Muskoka"** and get back a clean GeoJSON
(and SVG) outline, sourced from official Canadian open-data services.

Scope: **Canada, all boundary types** — not just Indigenous lands.

The app assumes internet access (the prompt parser requires it). Design accordingly:
the local database is a **searchable catalog with a geometry cache**, not a full offline
mirror of Canada. This distinction drives the whole architecture — read the next section
carefully before writing any code.

## Core architectural decision: index everything, fetch geometry on demand

A full geometry mirror of every Canadian boundary layer is tens of gigabytes (dissemination
areas alone are ~57,000 polygons). Don't do that. Instead:

- **Tier A — queryable services** (ESRI FeatureServer, OGC WFS): harvest **attributes and
  names only** (`returnGeometry=false`, or `propertyName` limited to name fields), plus each
  feature's bbox/extent. Store the native feature ID. Fetch full geometry lazily on export
  via `objectIds=` / `featureID=`, then cache it in the DB permanently.
- **Tier B — bulk-file sources** (StatCan zipped shapefiles, GML downloads, anything with no
  per-feature query API): download the whole file once, ingest geometry with it. These get a
  `bulk` flag and an explicit user-triggered download so nobody eats 400MB by accident.

Result: initial harvest is fast and light, search covers everything, and the geometry cache
warms up naturally around what the artist actually uses.

## Stack

- Electron (latest stable) + React + TypeScript + Vite, electron-builder for packaging
- `better-sqlite3` (native module — wire up `electron-rebuild`)
- Harvester runs as an Electron `utilityProcess`. Never in the renderer, never blocking main.
  Progress streams to the UI over IPC.
- `proj4` (reprojection), `@turf/turf` (geometry ops), `mapshaper` Node API (simplification),
  `maplibre-gl` (previews), `shapefile` + `yauzl` (Tier B ingest)
- `@anthropic-ai/sdk`, called **only from the main process**
- Strict TypeScript, ESLint + Prettier, Vitest on the resolve layer

**Hard constraint:** no GDAL, ogr2ogr, SpatiaLite, GEOS, or any system binary. Pure JS/WASM
only, so the app ships as one installer.

## Repo layout

```
src/
  main/          # IPC, window, Anthropic client, safeStorage key handling
  harvester/     # utilityProcess
    catalogs/    # arcgis-hub, ckan, esri-rest, ogc-wfs, bulk-file
    normalize/   # CRS, attribute mapping, alias extraction
  db/            # schema, migrations, queries
  resolve/       # prompt parsing, FTS + fuzzy matching, ranking
  export/        # geojson, svg, simplification
  renderer/      # React UI
```

## Layer taxonomy

The `feature_type` vocabulary is fixed and closed — every ingested layer maps to one of
these. Add new values only by editing the enum.

**Political / administrative**
`country`, `province_territory`, `federal_electoral_district`,
`provincial_electoral_district`, `census_division`, `census_subdivision`, `municipality`,
`municipal_ward`, `regional_district`

**Statistical (StatCan)**
`census_metropolitan_area`, `census_agglomeration`, `census_tract`, `population_centre`,
`dissemination_area`, `economic_region`

**Indigenous**
`indian_reserve`, `land_claim_settlement`, `treaty_area`, `inuit_region`,
`metis_settlement`, `first_nation_community`

**Service areas**
`health_region`, `school_board`, `forward_sortation_area`, `police_jurisdiction`,
`fire_service_area`, `emergency_management_zone`

**Physical / environmental**
`watershed`, `drainage_basin`, `ecozone`, `national_park`, `provincial_park`,
`protected_area`, `great_lake`, `major_river`

**Infrastructure**
`airport`, `port`, `rail_line`, `highway`, `transit_system`

Prioritize in this order for M1–M5: political → Indigenous → statistical → service →
physical → infrastructure. **Federal and provincial electoral districts are the highest-value
layers for a news channel** (election night graphics) — get those working early and correctly,
including historical redistribution vintages where the source offers them.

## Database schema

```sql
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'arcgis-hub'|'esri-rest'|'wfs'|'ckan'|'bulk-file'
  tier TEXT NOT NULL,           -- 'A' (queryable) | 'B' (bulk)
  endpoint TEXT NOT NULL,
  layer_id TEXT,
  feature_type TEXT NOT NULL,   -- from the taxonomy above
  jurisdiction TEXT,            -- 'CA' or province code
  vintage TEXT,                 -- e.g. '2021 census', '2023 representation order'
  licence TEXT,
  attribution TEXT,             -- exact on-air credit string
  name_fields TEXT,             -- JSON array of attribute names holding names/aliases
  last_harvested_at TEXT,
  feature_count INTEGER,
  status TEXT
);

CREATE TABLE features (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_feature_id TEXT NOT NULL,   -- OBJECTID / gml:id, for lazy geometry fetch
  official_name TEXT NOT NULL,
  feature_type TEXT NOT NULL,
  jurisdiction TEXT,
  attributes_json TEXT,              -- full original attribute bag, verbatim
  minx REAL, miny REAL, maxx REAL, maxy REAL,
  retrieved_at TEXT NOT NULL,
  UNIQUE(source_id, source_feature_id)
);

CREATE TABLE geometries (          -- the cache; populated lazily for Tier A
  feature_id INTEGER PRIMARY KEY REFERENCES features(id) ON DELETE CASCADE,
  geometry_json TEXT NOT NULL,     -- GeoJSON geometry, EPSG:4326
  vertex_count INTEGER,
  source_srid INTEGER,
  content_hash TEXT,
  cached_at TEXT NOT NULL
);

CREATE TABLE aliases (
  id INTEGER PRIMARY KEY,
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_kind TEXT,                 -- 'official'|'french'|'attribute'|'stripped'|'manual'
  UNIQUE(feature_id, alias)
);

CREATE VIRTUAL TABLE features_fts USING fts5(
  alias, content='', tokenize='unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE features_rtree USING rtree(id, minx, maxx, miny, maxy);
```

`attributes_json` is never discarded — provenance matters when a boundary goes to air.

## Harvest pipeline

### Source registry

Ship a seeded `sources` table covering the taxonomy above. **Verify every endpoint with a
live request before hardcoding it** — do not trust URLs from memory, mine or yours. Seed:

- **Statistics Canada** boundary files — provinces, census divisions, census subdivisions,
  CMAs, census tracts, population centres, economic regions, dissemination areas (Tier B)
- **Federal electoral districts** — current representation order (StatCan / Elections Canada)
- **Provincial electoral districts** — per-province, mostly on provincial ArcGIS Hubs
- **Aboriginal Lands of Canada Legislative Boundaries** (NRCan Surveyor General) —
  open.canada.ca dataset `522b07b9-78e2-4819-b736-ad9208eb1067`, also on ArcGIS Hub
- **Ontario GeoHub** (`geohub.lio.gov.on.ca`), **BC Data Catalogue** (CKAN + WFS),
  and the remaining provincial portals
- **CanVec / National Hydro Network** — water bodies, rivers (Tier B, large)
- **Canadian Protected and Conserved Areas Database (CPCAD)** — parks, protected areas
- **open.canada.ca CKAN** `package_search`, filtered to geospatial resource formats
- **Natural Earth** — coastline and neighbouring-country context layers

### Catalog clients

- **ArcGIS Hub**: `opendata.arcgis.com/api/v3/search` and `/api/v3/datasets` (JSON:API;
  `page[size]` maxes at 100 — paginate)
- **CKAN**: `/api/3/action/package_search`, then walk `resources[]` for `ESRI REST`, `WFS`,
  `GEOJSON`, `SHP`
- **ESRI REST**: `?f=json` for metadata; index with
  `/query?where=1=1&outFields=<name fields>&returnGeometry=false&f=json`; fetch geometry
  with `/query?objectIds=<id>&outSR=4326&f=geojson`
- **OGC WFS**: `GetCapabilities` → feature types → `GetFeature` with
  `propertyName` for indexing, `featureID` for geometry, `srsName=EPSG:4326`
- **Bulk file**: HEAD for size, warn the user above 100MB, stream to disk, unzip, parse
  with `shapefile`, read the `.prj` for CRS

### Gotchas to handle explicitly

- **Paging is mandatory.** ESRI caps at `maxRecordCount` (often 1000–2000) and flags
  `exceededTransferLimit: true`. Page with `resultOffset`/`resultRecordCount`; WFS uses
  `count`/`startIndex`. A silently truncated harvest is the worst failure mode in this app —
  after every source, compare the row count against the service's own
  `returnCountOnly=true` and mark the source failed on mismatch.
- **CRS.** Always request 4326. If a source only serves 3347/3161/3005/3857, reproject with
  proj4 and record `source_srid`. Watch WFS 2.0 axis-order flips. Validate harvested
  geometry falls roughly within lon −141..−52, lat 41..84 and fail loudly if not.
- **Duplicate coverage is expected and fine.** The same reserve appears in the NRCan layer
  and in Ontario's. Keep both, tag them by source, and let ranking prefer the authoritative
  one (federal for reserves, StatCan for census geography, provincial for provincial layers).
- **Rate limiting**: 3 concurrent requests per host, exponential backoff on 429/5xx,
  resumable harvest with per-source checkpoints.

### Alias seeding

At ingest, push every plausible name field into `aliases` — `NAME1`, `NAME2`, French
variants, `CSDNAME`, `CDNAME`, `FEDNAME`, band names, reserve numbers, the official name
itself. Also store a stripped form (lowercase, no diacritics, no "First Nation", "Indian
Reserve No. 16", "IR", "City of", "Township of", punctuation normalized — note that
riding names use em dashes, which must normalize to plain hyphens for matching).

**This is the make-or-break part of the app.** The test query says "Parry Island First
Nation" but the federal record may be filed under a different official band name with the
locality only in a secondary attribute. Matching must succeed anyway.

## Resolve layer

1. Send the raw prompt to Claude (`claude-sonnet-4-6`) with a system prompt demanding
   **JSON only** — no prose, no markdown fences:
   ```json
   {
     "place_names": ["Parry Island First Nation"],
     "feature_type_hint": "indian_reserve",
     "jurisdiction_hint": "ON",
     "vintage_hint": null,
     "wants": "outline",
     "notes": ""
   }
   ```
   Validate with zod. `feature_type_hint` must be a value from the taxonomy — pass the
   enum in the system prompt. On parse failure, fall back to the keyword parser.
2. FTS5 on the extracted names, unioned with a trigram/Levenshtein fuzzy pass over
   `aliases`, filtered by any type/jurisdiction hint. Take top ~15.
3. Send candidates back to Claude for ranking — name, type, jurisdiction, source, vintage,
   key attributes. **Never geometry.** Get back a confidence score and one-line
   justification each.
4. **Always present the top 5 in the UI with map thumbnails. Never auto-export a single
   result, even at high confidence.** A wrong boundary on air costs far more than a click.
5. Geometry is fetched at this point (or on selection) for whatever isn't cached, with a
   visible loading state.

### API key handling

Entered in Settings, stored via Electron `safeStorage`, never in renderer memory, never
logged, never written into the SQLite file. All Anthropic calls originate in main.

## Export

- **GeoJSON** — RFC 7946, EPSG:4326, right-hand-rule winding, `Feature` with attributes plus
  a `_provenance` block (source, licence, attribution, vintage, retrieved_at, source URL)
- **SVG** — projected (default Lambert EPSG:3347, offer BC Albers 3005 and Web Mercator),
  fitted to a user-set canvas, one `<path>` per ring, Illustrator/After Effects ready
- **Simplification slider** — mapshaper topology-preserving Visvalingam, live vertex count
  before/after, default ~5% retention. Raw survey boundaries carry six figures of vertices
  and will choke Illustrator.
- **Multi-feature export** — "all federal ridings in Ontario", "every reserve within this
  bbox" — as one FeatureCollection with shared boundaries preserved topologically
  (mapshaper handles this; simplifying features independently creates visible gaps).
- Show the attribution string next to the export button so the credit can be copied straight
  into the lower-third.

## UI

Four panes: **Sources** (registry, harvest status, per-source progress, bulk-download
warnings) — **Search** (prompt box, candidate list with thumbnails, type/jurisdiction
filters) — **Preview** (maplibre map, vertex count, bbox) — **Export** (format, projection,
simplification, canvas size, attribution).

Dark, dense, keyboard-driven. This is a working tool for someone under deadline pressure.
No modal dialogs anywhere in the search-to-export path.

## Milestones — stop after each and report

- **M0** — Scaffold at `C:\Users\billk\Projects\ShinTech\GIS-Browser`, schema + migrations,
  IPC skeleton, taxonomy enum, empty UI shells
- **M1** — ESRI REST + WFS clients with paging, count verification, CRS handling.
  Index-only harvest of the Aboriginal Lands layer + federal electoral districts.
- **M2** — Lazy geometry fetch and cache; preview pane rendering a real boundary
- **M3** — FTS5 + fuzzy matching + alias seeding. **Acceptance test: "Parry Island First
  Nation" returns the correct reserve in the top 3 with the LLM switched off entirely.**
- **M4** — Claude parse + rank layer, safeStorage key handling
- **M5** — Export: GeoJSON, SVG, simplification, provenance, multi-feature
- **M6** — Tier B bulk ingest (StatCan census geography), download manager
- **M7** — Catalog discovery crawlers (ArcGIS Hub + CKAN), remaining provincial sources
- **M8** — electron-builder packaging, first-run setup wizard

## Rules

- Ask before adding any dependency not listed above
- No mock data anywhere — a failed fetch fails loudly with HTTP status and URL
- Every network call gets a timeout, a retry policy, and a log line
- Commit at each milestone with a descriptive message
- Write tests for the resolve layer before wiring the UI to it

Start with M0. Show me the schema and the seeded source registry before writing any fetchers.
