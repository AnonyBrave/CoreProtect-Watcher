# CoreProtect-Watcher

Monitoring for a Minecraft server based on [CoreProtect](https://github.com/RayFarkas/CorePro) logs: the agent copies MySQL events into a local SQLite cache, detects incidents (thefts, griefing, mining anomalies, suspicious chat), and exposes a web interface + API for administrators.

npm package name: `coreprotect-watcher`. The interface is displayed as “CoreProtect-Watcher”. The old names `cp-sentry` remain accepted for compatibility (`CP_SENTRY_PORT`, `data/cp-sentry.db`) so that startup does not break.

## Architecture

- **Ingestion**: a cycle every `CP_INGEST_SECONDS` (120 s in `.env`), incremental MySQL → SQLite copy using a saved cursor. Three modes (`CP_SOURCE`): `auto` (MySQL when reachable, otherwise dropped files), `mysql` (direct stream only), `files` (SQL dumps copied into the import folder, no server).
- **Incremental analysis**: statistics per chunk, physical clusters of containers, container ownership and co-owners (one container can belong to several players), detection of `theft`, `theft_shared` (a theft between co-owners), `dupe` (three signatures: replace-in-container, ground creation, chunk cloning), `grief`, `anomaly`, `chat`, player risk score. Full recomputation every `CP_RECOMPUTE_MINUTES`.
- **API + UI**: Fastify listens on `0.0.0.0:CP_WATCHER_PORT` (8765) and serves `dist/` (UI built by Vite), the `/api/*` routes, an SSE stream (`/api/stream`), and Discord notifications filtered by severity.
- **SquareMap map**: the single “Map” tab displays the tiles of the SquareMap instance (Leaflet, projection `CRS.Simple`), with Watcher layers placed on top: clickable incidents pointing to the alert, containers colored by ownership state, density of blocks placed per chunk, house footprints, live tracked players. Tiles and JSON are relayed server-side (`/api/squaremap/*`) to avoid CORS; the correspondence between a Watcher world and a SquareMap world is configured in Settings (`squaremap_json`).
- **Data**: all cache lives in `data/coreprotect-watcher.db` (SQLite). MySQL is never modified: read-only connection.

## Prerequisites

- Node.js 22 LTS + npm (local dev)
- Docker 24+ and Docker Compose v2 (containerized version)
- A CoreProtect MySQL server reachable from the machine (read-only access recommended)

## Run locally

```bash
cp .env.example .env      # then fill in the MySQL password and the admin token
npm install
npm run build:web         # builds dist/ served by the API
npm start                 # API + UI at http://localhost:8765
npm run typecheck         # type checking
```

In dev, `npm run dev:web` launches Vite on 5173 with a proxy `/api → 127.0.0.1:8765`. The API server must be running alongside.

## Run with Docker

`.env` is read by Compose (it is **never** committed):

```bash
cp .env.example .env      # fill in the MySQL password + admin token
docker compose up -d --build
curl http://localhost:8765/api/worlds
```

- `Dockerfile`: multi-stage `node:22-alpine` — build of production dependencies (better-sqlite3 compiled for musl), Vite UI build into `dist/`, minimal final image run by the non-root user `node`.
- `compose.yaml`: a single `watcher` service, port `8765:8765`, named volume `cpw-data` for the SQLite cache, restart `unless-stopped`, health check via `/api/worlds`, bounded logs (10 MB × 3 files).
- CoreProtect MySQL stays on the LAN: no DB service is added to the stack. If the cache must remain in the local repository, replace the volume by `./data:/app/data`.
- `TZ=Europe/Paris` for readable timestamps; the container time follows the `TZ` line.

First launch: complete backfill from MySQL then a heavy recomputation, depending on CoreProtect table size (a few minutes on a big server).

## Server deployment with DockGe (public image on ghcr.io)

The workflow `.github/workflows/docker.yml` builds the image on every push to `main`, and pushes tags `latest` and `sha-<commit>` to **ghcr.io/anonybrave/coreprotect-watcher** — a public package, visible in *Packages → coreprotect-watcher*. It uses only the workflow token (`GITHUB_TOKEN`): no secret is written into the stack.

Stack to paste in DockGe (the server pulls the image from the registry, it does not build from GitHub):

```yaml
name: coreprotect-watcher
services:
  watcher:
    image: ghcr.io/anonybrave/coreprotect-watcher:latest
    container_name: coreprotect-watcher
    restart: unless-stopped
    env_file:
      - .env
    environment:
      CP_WATCHER_PORT: "8765"
      CP_SQLITE_FILE: /app/data/coreprotect-watcher.db
      TZ: Europe/Paris
    ports:
      - 8765:8765
    volumes:
      - /data/coreprotect-watcher:/app/data
    init: true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
networks: {}
```

- The `image:` key is required for DockGe to be able to pull. Replace `/data/coreprotect-watcher` with the path used by your server, and fill in `.env`; never add tokens to this file.
- Activate “monitor new deployments” on the stack: each time GitHub Actions publishes a new image, DockGe detects a new digest, removes the old container, and relaunches the latest tag. This replaces the “skipped – no image to be pulled” display, caused by a stack with no `image:` reference — DockGe had nothing to pull from the registry.
- Pin a version: replace `:latest` with `:sha-xxxxxxx` (the commit tag) to freeze the deployment, then “Redeploy”.
- **Never** put a PAT in `build.context: https://<token>@github.com/...`: that token stays readable in the stack, logs, and UI.

## Importing SQL files (without a MySQL server)

The SQLite cache can be fed by `mysqldump` exports dropped into the import directory (`CP_IMPORT_DIR`, default `data/imports`):

```bash
mysqldump -h YOUR-MYSQL-HOST -u MYSQL-USER -p coreprotect co_block     > data/imports/co_block.sql
mysqldump -h YOUR-MYSQL-HOST -u MYSQL-USER -p coreprotect co_container > data/imports/co_container.sql
gzip data/imports/co_item.sql        # .sql.gz files are accepted too
```

- The directory is inspected at every cycle: a file is imported only once (journal `import_files_json` in the database, visible in Settings with its state: “pending”, “imported”, “read failure” and the number of inserted rows).
- Recognized tables: `co_user`, `co_world`, `co_material_map`, `co_block`, `co_container`, `co_item`, `co_session`, `co_chat`, `co_command`, `co_login`/`username_log`. Columns are mapped by position in the mysqldump `CREATE TABLE`, or by explicit list in `INSERT INTO ... (col,...)`; user names become cache uids.
- Import never touches MySQL: it is a **read-only** file source, suited to servers whose logs are exported periodically (`CP_SOURCE=files`, or `auto` when MySQL is unreachable).

## Map (SquareMap + Watcher layers)

- The instance base URL is `squaremap_json.url` (e.g. `https://squaremap.example.com`). The “SquareMap” tab centers on the spawn of the mapped world, at the instance default zoom; links from alerts, players and containers (“see on map”) recenter the map.
- Correspondence to fill in Settings: each cached `wid` (world, world_nether, world_the_end) maps to the instance’s world name (`minecraft_overworld`, `minecraft_the_nether`, `minecraft_the_end`). The tab proposes names live from `/api/squaremap/worlds`.
- Watcher layers: incidents (colored dot per severity, click = open alert), containers (green owned, yellow public, purple shared, gray ambiguous), density of blocks placed per chunk tinted by player, house/territory footprints, SquareMap-connected players (heads + name, refreshed every 5 s). Each layer can be hidden independently.
- Tiles and JSON (`settings.json`, `players.json`) go through the server proxy; tile images use `https://…/tiles/{world}/{z}/{x}_{y}.png` directly (512 px, Leaflet projection `CRS.Simple`).

## Environment variables

| Variable | Default | Role |
| --- | --- | --- |
| `CP_DB_HOST` / `CP_DB_PORT` | `localhost` / `3306` | CoreProtect MySQL |
| `CP_DB_USER` / `CP_DB_PASSWORD` / `CP_DB_NAME` | `coreprotectui` / `` / `coreprotect` | Credentials (read-only) |
| `CP_SOURCE` | `auto` | Data source: `auto`, `mysql`, `files` |
| `CP_IMPORT_DIR` | `data/imports` | Import directory for SQL files (.sql, .sql.gz) |
| `CP_WATCHER_PORT` | `8765` | API + UI port (`CP_SENTRY_PORT` read as fallback) |
| `CP_ADMIN_TOKEN` | `coreprotect-watcher-admin` | Token for API writes; must be changed. |
| `CP_INGEST_SECONDS` | `30` (`.env`: 120) | Ingestion frequency |
| `CP_RECOMPUTE_MINUTES` | `10` (`.env`: 60) | Full recomputation frequency |
| `DISCORD_WEBHOOK_URL` | `` | Webhook; empty = notifications disabled |
| `CP_SQLITE_FILE` | `data/coreprotect-watcher.db` | SQLite cache location |

## Security

- `.env` contains the MySQL password: git ignores it, and only fictional coordinates are published in `.env.example`.
- The admin token protects API writes (`POST /api/settings`, `POST /api/incidents/:id`, `POST /api/cycle/run`). It must be customized; if a browser kept an old token, re-enter it in Settings.
- A GitHub PAT only belongs in the credential store (Git) or DockGe secrets: never in a Compose stack (`context:` as git URL), nor in a committed `.env`. For pulling the image from GHCR, authentication is not needed while the package stays public; do not embed tokens into any stack.
- The UI is not authenticated: reserve it to trusted networks (LAN / VPN), and keep a strong token in front of all writes.

## API

Read: `/api/overview`, `/api/players`, `/api/players/:uid`, `/api/worlds`, `/api/scores`, `/api/containers`, `/api/incidents` (filters `kind`, `status`, `minSeverity`, `wid`, `x0/x1/z0/z1` for the map), `/api/incidents/:id`, `/api/houses`, `/api/map`, `/api/shares` (co-owners, optional `?key=`), `/api/imports` (SQL import directory and journal), `/api/squaremap/settings`, `/api/squaremap/worlds`, `/api/squaremap/world/:name`, `/api/squaremap/players`, `/api/settings`, `/api/export.csv`, `/api/stream` (SSE).

Writes with `x-admin-token`: `POST /api/incidents/:id`, `POST /api/settings`, `POST /api/cycle/run`.

## Licence

Private project, all rights reserved.