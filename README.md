# CoreProtect-Watcher

Surveillance d'un serveur Minecraft à partir des journaux de [CoreProtect](https://github.com/RayFarkas/CorePro) : le robot copie les événements MySQL dans un cache SQLite local, détecte les incidents (vols, grief, anomalies de minage, propos suspects), et expose une interface web + API pour les administrateurs.

Nom du paquet npm : `coreprotect-watcher`. L'interface s'affiche sous « CoreProtect-Watcher ». Les anciens noms `cp-sentry` restent acceptés en compatibilité (`CP_SENTRY_PORT`, `data/cp-sentry.db`) pour ne rien casser au démarrage.

## Architecture

- **Ingestion** : cycle toutes les `CP_INGEST_SECONDS` (120 s dans `.env`), copie incrémentale MySQL → SQLite via un curseur sauvegardé.
- **Analyse incrémentale** : statistiques par chunk, clusters physiques de conteneurs, propriété des conteneurs, détection `theft`, `grief`, `anomaly`, `chat`, score de risque joueur. Recomputation complète tous les `CP_RECOMPUTE_MINUTES`.
- **API + UI** : Fastify écoute sur `0.0.0.0:CP_WATCHER_PORT` (8765) et sert `dist/` (UI construite par Vite), les routes `/api/*`, un flux SSE (`/api/stream`) et des notifications Discord filtrées par sévérité.
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

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `CP_DB_HOST` / `CP_DB_PORT` | `192.168.1.30` / `3306` | MySQL CoreProtect |
| `CP_DB_USER` / `CP_DB_PASSWORD` / `CP_DB_NAME` | `coreprotectui` / `` / `coreprotect` | Identifiants (lecture seule) |
| `CP_WATCHER_PORT` | `8765` | Port de l'API + UI (`CP_SENTRY_PORT` lu en fallback) |
| `CP_ADMIN_TOKEN` | `coreprotect-watcher-admin` | Jeton des écritures API ; à changer |
| `CP_INGEST_SECONDS` | `30` (`.env` : 120) | Fréquence d'ingestion |
| `CP_RECOMPUTE_MINUTES` | `10` (`.env` : 60) | Fréquence des recomputations complètes |
| `DISCORD_WEBHOOK_URL` | `` | Webhook ; vide = notifications désactivées |
| `CP_SQLITE_FILE` | `data/coreprotect-watcher.db` | Emplacement du cache SQLite |

## Sécurité

- `.env` porte le mot de passe MySQL : il est ignoré par git, seules les coordonnées fictives de `.env.example` sont publiées.
- Le jeton d'admin protège les écritures API (`POST /api/settings`, `POST /api/incidents/:id`, `POST /api/cycle/run`). Il est à personnaliser ; si un navigateur a gardé l'ancien jeton, le ressaisir dans Réglages.
- L'UI n'est pas authentifiée : la réserver aux réseaux de confiance (LAN / VPN), et mettre un jeton fort en face des écritures.

## API

Lecture : `/api/overview`, `/api/players`, `/api/players/:uid`, `/api/worlds`, `/api/scores`, `/api/containers`, `/api/incidents`, `/api/incidents/:id`, `/api/houses`, `/api/map`, `/api/settings`, `/api/export.csv`, `/api/stream` (SSE).

Écritures avec `x-admin-token` : `POST /api/incidents/:id`, `POST /api/settings`, `POST /api/cycle/run`.

## Licence

Projet privé, tous droits réservés.
