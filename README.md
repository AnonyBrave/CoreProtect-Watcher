# CoreProtect-Watcher

Surveillance d'un serveur Minecraft à partir des journaux de [CoreProtect](https://github.com/RayFarkas/CorePro) : le robot copie les événements MySQL dans un cache SQLite local, détecte les incidents (vols, grief, anomalies de minage, propos suspects), et expose une interface web + API pour les administrateurs.

Nom du paquet npm : `coreprotect-watcher`. L'interface s'affiche sous « CoreProtect-Watcher ». Les anciens noms `cp-sentry` restent acceptés en compatibilité (`CP_SENTRY_PORT`, `data/cp-sentry.db`) pour ne rien casser au démarrage.

## Architecture

- **Ingestion** : cycle toutes les `CP_INGEST_SECONDS` (120 s dans `.env`), copie incrémentale MySQL → SQLite via un curseur sauvegardé. Trois modes (`CP_SOURCE`) : `auto` (MySQL si joignable, sinon fichiers déposés), `mysql` (flux direct uniquement), `files` (dépôt de dumps SQL, sans serveur).
- **Analyse incrémentale** : statistiques par chunk, clusters physiques de conteneurs, propriété des conteneurs et copropriétaires (un conteneur peut appartenir à plusieurs joueurs), détection `theft`, `theft_shared` (vol entre copropriétaires), `dupe` (trois signatures : copie-remplacement dans un conteneur, création au sol, clonage de chunk), `grief`, `anomaly`, `chat`, score de risque joueur. Recomputation complète tous les `CP_RECOMPUTE_MINUTES`.
- **API + UI** : Fastify écoute sur `0.0.0.0:CP_WATCHER_PORT` (8765) et sert `dist/` (UI construite par Vite), les routes `/api/*`, un flux SSE (`/api/stream`) et des notifications Discord filtrées par sévérité.
- **Carte SquareMap** : l'onglet unique « Carte » affiche les tuiles de l'instance SquareMap (Leaflet, projection `CRS.Simple`), avec les calques Watcher posés dessus : incidents cliquables vers l'alerte, conteneurs colorés selon leur état de propriété, densité de blocs posés par chunk, emprises des maisons, joueurs suivis en direct. Les tuiles et les JSON sont relayés côté serveur (`/api/squaremap/*`) pour éviter le CORS ; la correspondance monde Watcher → monde SquareMap se règle dans Réglages (`squaremap_json`).
- **Données** : tout le cache est dans `data/coreprotect-watcher.db` (SQLite). MySQL n'est jamais modifié : connexion en **lecture seule**.

## Prérequis

- Node.js 22 LTS + npm (dev local)
- Docker 24+ et Docker Compose v2 (version conteneurisée)
- Un serveur MySQL CoreProtect joignable depuis la machine (accès lecture seule recommandé)

## Lancement en local

```bash
cp .env.example .env      # puis remplir le mot de passe MySQL et le jeton d'admin
npm install
npm run build:web         # construit dist/ servi par le serveur
npm start                 # API + UI sur http://localhost:8765
npm run typecheck         # vérification des types
```

En dev, `npm run dev:web` lance Vite sur 5173 avec un proxy `/api → 127.0.0.1:8765`. Le serveur doit tourner à côté.

## Lancement avec Docker

`.env` est lu par Compose (il n'est **jamais** commité) :

```bash
cp .env.example .env      # remplir le mot de passe MySQL + le jeton d'admin
docker compose up -d --build
curl http://localhost:8765/api/worlds
```

- `Dockerfile` multi-stage `node:22-alpine` : build des dépendances de production (better-sqlite3 compilé pour musl), build Vite de l'UI dans `dist/`, image finale minimale exécutée par l'utilisateur non-root `node`.
- `compose.yaml` : un seul service `watcher`, port `8765:8765`, volume nommé `cpw-data` pour le cache SQLite, redémarrage `unless-stopped`, contrôle de santé via `/api/worlds`, journaux bornés (10 Mo × 3 fichiers).
- Le MySQL CoreProtect reste sur le LAN : aucun service DB n'est ajouté à la pile. Si le cache doit rester dans le dépôt local, remplacer le volume par `./data:/app/data`.
- `TZ=Europe/Paris` pour des horodatages lisibles ; l'heure du conteneur suit le fuseau de la ligne `TZ`.

Premier lancement : backfill complet depuis MySQL puis recomputation lourde, selon la taille des tables CoreProtect (quelques minutes sur un gros serveur).

## Déploiement serveur avec DockGe (image privée sur ghcr.io)

Le workflow `.github/workflows/docker.yml` construit l'image à chaque push sur `main` et pousse les étiquettes `latest` et `sha-<commit>` sur **ghcr.io/anonybrave/coreprotect-watcher** (package créé **privé**, visible dans *Packages → coreprotect-watcher*). Il utilise uniquement le jeton du workflow (`GITHUB_TOKEN`) : aucun secret n'est écrit dans la stack.

Stack à coller dans DockGe (le serveur tire l'image du registre, il ne build pas depuis GitHub) :

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
      - /mnt/ZFS_RAID_1/coreprotect-watcher:/app/data
    init: true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
networks: {}
```

- Dans DockGe, enregistrez un accès au registre `ghcr.io` : nom d'utilisateur GitHub (`AnonyBrave`) et un **PAT classic scopé `read:packages`** (et rien d'autre). DockGe utilise ce secret pour le pull ; il n'apparaît pas dans le YAML.
- Activer « surveiller les nouveaux déploiements » sur la stack : à chaque nouvelle image publiée par GitHub Actions, DockGe détecte un nouveau digest, retire l'ancien conteneur et relance avec la dernière étiquette. C'est ce qui remplace l'affichage « skipped – no image to be pulled », dû au fait que la stack ne contenait aucune référence d'image (`image:`), donc DockGe n'avait rien à tirer du registre.
- Épingler une version : remplacer `:latest` par `:sha-xxxxxxx` (l'étiquette du commit) pour figer le déploiement, puis « Redéployer ».
- Ne **jamais** mettre un PAT dans `build.context: https://<token>@github.com/...` : le token reste lisible dans la stack, les journaux et l'UI.

## Import de fichiers SQL (sans serveur MySQL)

Le cache SQLite peut être alimenté par des exports `mysqldump` posés dans le dépôt d'import (`CP_IMPORT_DIR`, défaut `data/imports`) :

```bash
mysqldump -h 192.168.1.30 -u coreprotectui -p coreprotect co_block     > data/imports/co_block.sql
mysqldump -h 192.168.1.30 -u coreprotectui -p coreprotect co_container > data/imports/co_container.sql
gzip data/imports/co_item.sql        # les .sql.gz sont acceptés
```

- Le dépôt est scruté à chaque cycle : un fichier est importé une seule fois (journal `import_files_json` dans la base, visible dans l'onglet Réglages avec son état : « en attente », « importé », « échec de lecture » et le nombre de lignes insérées).
- Tables reconnues : `co_user`, `co_world`, `co_material_map`, `co_block`, `co_container`, `co_item`, `co_session`, `co_chat`, `co_command`, `co_login`/`username_log`. Les colonnes sont mappées par la position dans le `CREATE TABLE` de mysqldump, ou par la liste explicite des `INSERT INTO ... (col,...)` ; les noms d'utilisateur deviennent des uid du cache.
- L'import ne touche jamais MySQL : c'est une source **lecture seule** de fichiers, adaptée aux serveurs dont on exporte les logs périodiquement (`CP_SOURCE=files`, ou `auto` quand MySQL est injoignable).

## Carte (SquareMap + calques Watcher)

- La base de l'instance est l'URL `squaremap_json.url` (ex. `https://dynmap.anonybrave.fr`). L'onglet « SquareMap » centre sur le spawn du monde mappé, au zoom par défaut de l'instance ; les liens des alertes, joueurs et conteneurs (« voir sur la carte ») recentrent la carte.
- Correspondance à renseigner dans Réglages : chaque `wid` du cache (world, world_nether, world_the_end) vers le nom de monde de l'instance (`minecraft_overworld`, `minecraft_the_nether`, `minecraft_the_end`). L'onglet propose les noms trouvés en direct via `/api/squaremap/worlds`.
- Calques Watcher : incidents (pastille colorée selon la sévérité, clic = ouvrir l'alerte), conteneurs (vert possédé, jaune public, violet partagé, gris ambigu), densité de blocs posés par chunk teintée par joueur, emprises maisons/territoires, joueurs connectés suivis par SquareMap (têtes + nom, rafraîchies toutes les 5 s). Chaque calque se masque indépendamment.
- Les tuiles et JSON (`settings.json`, `players.json`) passent par le proxy serveur ; l'affichage des images de tuiles utilise directement `https://…/tiles/{monde}/{z}/{x}_{y}.png` (512 px, projection Leaflet `CRS.Simple`).

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `CP_DB_HOST` / `CP_DB_PORT` | `192.168.1.30` / `3306` | MySQL CoreProtect |
| `CP_DB_USER` / `CP_DB_PASSWORD` / `CP_DB_NAME` | `coreprotectui` / `` / `coreprotect` | Identifiants (lecture seule) |
| `CP_SOURCE` | `auto` | Source des données : `auto`, `mysql`, `files` |
| `CP_IMPORT_DIR` | `data/imports` | Dépôt des fichiers SQL (.sql, .sql.gz) |
| `CP_WATCHER_PORT` | `8765` | Port de l'API + UI (`CP_SENTRY_PORT` lu en fallback) |
| `CP_ADMIN_TOKEN` | `coreprotect-watcher-admin` | Jeton des écritures API ; à changer |
| `CP_INGEST_SECONDS` | `30` (`.env` : 120) | Fréquence d'ingestion |
| `CP_RECOMPUTE_MINUTES` | `10` (`.env` : 60) | Fréquence des recomputations complètes |
| `DISCORD_WEBHOOK_URL` | `` | Webhook ; vide = notifications désactivées |
| `CP_SQLITE_FILE` | `data/coreprotect-watcher.db` | Emplacement du cache SQLite |

## Sécurité

- `.env` porte le mot de passe MySQL : il est ignoré par git, seules les coordonnées fictives de `.env.example` sont publiées.
- Le jeton d'admin protège les écritures API (`POST /api/settings`, `POST /api/incidents/:id`, `POST /api/cycle/run`). Il est à personnaliser ; si un navigateur a gardé l'ancien jeton, le ressaisir dans Réglages.
- Un PAT GitHub ne se met que dans le magasin d'identifiants (Git) ou les secrets de DockGe : jamais dans une stack Compose (`context:` en URL git), ni dans `.env` commité. Pour le pull des images, un PAT **classic scopé `read:packages`** suffit ; le package GHCR reste privé.
- L'UI n'est pas authentifiée : la réserver aux réseaux de confiance (LAN / VPN), et mettre un jeton fort en face des écritures.

## API

Lecture : `/api/overview`, `/api/players`, `/api/players/:uid`, `/api/worlds`, `/api/scores`, `/api/containers`, `/api/incidents` (filtres `kind`, `status`, `minSeverity`, `wid`, `x0/x1/z0/z1` pour la carte), `/api/incidents/:id`, `/api/houses`, `/api/map`, `/api/shares` (copropriétaires, option `?key=`), `/api/imports` (dépôt SQL et journal d'import), `/api/squaremap/settings`, `/api/squaremap/worlds`, `/api/squaremap/world/:nom`, `/api/squaremap/players`, `/api/settings`, `/api/export.csv`, `/api/stream` (SSE).

Écritures avec `x-admin-token` : `POST /api/incidents/:id`, `POST /api/settings`, `POST /api/cycle/run`.

## Licence

Projet privé, tous droits réservés.
