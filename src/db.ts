import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";

fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });
export const db = new Database(cfg.dbFile);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = OFF");

const DDL = `
-- Curseurs de réplication (un par table MySQL)
CREATE TABLE IF NOT EXISTS sync_cursor (
  tbl TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  rows_total INTEGER NOT NULL DEFAULT 0
);

-- Identité : clé canonique = co_user.rowid
CREATE TABLE IF NOT EXISTS player (
  uid INTEGER PRIMARY KEY,
  uuid TEXT,
  name TEXT,
  is_fake INTEGER NOT NULL DEFAULT 0,
  is_whitelisted INTEGER NOT NULL DEFAULT 0,
  total_placed INTEGER NOT NULL DEFAULT 0,
  total_broken INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS username_log (
  rowid INTEGER PRIMARY KEY,
  time INTEGER,
  uuid TEXT,
  user TEXT
);

CREATE TABLE IF NOT EXISTS world (wid INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS material (id INTEGER PRIMARY KEY, name TEXT);

-- co_block : une ligne = une action sur un bloc
CREATE TABLE IF NOT EXISTS blk (
  rowid INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  uid INTEGER,
  wid INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  type_id INTEGER NOT NULL,
  bdata INTEGER,
  action INTEGER NOT NULL,
  rolled_back INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_blk_wxz ON blk(wid, x, z);
CREATE INDEX IF NOT EXISTS ix_blk_uid_time ON blk(uid, time);
CREATE INDEX IF NOT EXISTS ix_blk_type_time ON blk(type_id, time);

-- co_container : mouvements d'objets dans un conteneur (clé = wid,x,y,z)
CREATE TABLE IF NOT EXISTS container_evt (
  rowid INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  uid INTEGER,
  wid INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  action INTEGER NOT NULL,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS ix_cont_key ON container_evt(wid, x, y, z, time);
CREATE INDEX IF NOT EXISTS ix_cont_uid ON container_evt(uid, time);

-- co_item : ramassage/perte d'items au sol
CREATE TABLE IF NOT EXISTS item_evt (
  rowid INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  uid INTEGER,
  wid INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  type_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  action INTEGER NOT NULL,
  rolled_back INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_item_uid ON item_evt(uid, time);

-- co_session : login/logout (action 0 = login, 1 = logout)
CREATE TABLE IF NOT EXISTS session_evt (
  rowid INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  uid INTEGER,
  wid INTEGER,
  x INTEGER, y INTEGER, z INTEGER,
  action INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sess_uid ON session_evt(uid, time);

-- co_chat / co_command : FTS5 si disponible, table normale sinon
CREATE TABLE IF NOT EXISTS chat_evt (
  rowid INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  uid INTEGER,
  wid INTEGER,
  x INTEGER, y INTEGER, z INTEGER,
  msg TEXT
);
CREATE INDEX IF NOT EXISTS ix_chat_uid ON chat_evt(uid, time);

CREATE TABLE IF NOT EXISTS command_evt (
  rowid INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  uid INTEGER,
  wid INTEGER,
  x INTEGER, y INTEGER, z INTEGER,
  cmd TEXT
);
CREATE INDEX IF NOT EXISTS ix_cmd_uid ON command_evt(uid, time);

-- Agrégations par chunk 16x16 (base de la détection de maison)
CREATE TABLE IF NOT EXISTS chunk_stat (
  uid INTEGER, wid INTEGER, cx INTEGER, cz INTEGER,
  placed INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0,
  functional INTEGER NOT NULL DEFAULT 0,
  first_time INTEGER, last_time INTEGER,
  PRIMARY KEY (wid, cx, cz, uid)
);

-- Types fonctionnels / conteneurs (résolus depuis co_material_map)
CREATE TABLE IF NOT EXISTS functional_type (id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS container_type (id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS item_rarity (id INTEGER PRIMARY KEY, bonus REAL NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS home_cluster (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  wid INTEGER NOT NULL,
  cx0 INTEGER, cz0 INTEGER, cx1 INTEGER, cz1 INTEGER,
  blocks_placed INTEGER NOT NULL,
  functional_count INTEGER NOT NULL DEFAULT 0,
  distinct_types INTEGER NOT NULL,
  first_seen INTEGER, last_seen INTEGER,
  center_x REAL, center_z REAL,
  kind TEXT NOT NULL DEFAULT 'house'    -- house (bâtiment) | territory (terrassement dense)
);
CREATE INDEX IF NOT EXISTS ix_home_uid ON home_cluster(uid);

-- Propriété inférée des conteneurs : un conteneur physique = position d'un bloc conteneur posé
CREATE TABLE IF NOT EXISTS phys_container (
  key TEXT PRIMARY KEY,           -- wid|x|y|z du bloc conteneur
  wid INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
  type_id INTEGER,
  placed_uid INTEGER,             -- qui a posé le bloc (-1 = inconnu)
  total_events INTEGER NOT NULL DEFAULT 0,
  deposits INTEGER NOT NULL DEFAULT 0,
  withdraws INTEGER NOT NULL DEFAULT 0,
  volume INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER, last_seen INTEGER,
  orphan INTEGER NOT NULL DEFAULT 0   -- 1 = position d'interaction sans bloc conteneur connu
);
CREATE INDEX IF NOT EXISTS ix_phys_wxz ON phys_container(wid, x, z);

-- Mapping événement -> conteneur physique (position d'interaction du joueur)

CREATE TABLE IF NOT EXISTS container_owner (
  key TEXT PRIMARY KEY,
  owner_uid INTEGER,
  score REAL NOT NULL DEFAULT 0,
  trust_state TEXT NOT NULL DEFAULT 'untracked',   -- owned|public|ambiguous|untracked
  locked INTEGER NOT NULL DEFAULT 0,               -- propriété établie par preuve solide
  evidence_json TEXT
);

CREATE TABLE IF NOT EXISTS usage_stat (
  key TEXT, uid INTEGER,
  deposits INTEGER NOT NULL DEFAULT 0,
  withdraws INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  volume INTEGER NOT NULL DEFAULT 0,
  first_time INTEGER, last_time INTEGER,
  PRIMARY KEY (key, uid)
);

-- Incidents & scores
CREATE TABLE IF NOT EXISTS incident (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,          -- theft|grief|anomaly|chat
  severity REAL NOT NULL,
  uid INTEGER, wid INTEGER, x INTEGER, y INTEGER, z INTEGER,
  victim_uid INTEGER, container_key TEXT, item_id INTEGER, amount INTEGER,
  window_start INTEGER, window_end INTEGER,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',        -- new|seen|closed
  note TEXT,
  created_at INTEGER NOT NULL,
  event_rowid INTEGER
);
CREATE INDEX IF NOT EXISTS ix_incident_time ON incident(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_incident_dedupe ON incident(kind, event_rowid);

CREATE TABLE IF NOT EXISTS player_score (
  uid INTEGER, day INTEGER,
  theft_s REAL NOT NULL DEFAULT 0,
  grief_s REAL NOT NULL DEFAULT 0,
  anomaly_s REAL NOT NULL DEFAULT 0,
  chat_s REAL NOT NULL DEFAULT 0,
  composite REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, day)
);

-- Configuration modifiable depuis l'UI
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS notify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER, channel TEXT, status TEXT, detail TEXT, created_at INTEGER
);

-- Progression de l'analyse incrémentale
CREATE TABLE IF NOT EXISTS analysis_state (key TEXT PRIMARY KEY, value TEXT);
`;

db.exec(DDL);

/** Migration douce : ajoute les colonnes apparues après la création de la base. */
function ensureColumn(table: string, col: string, type: string): void {
  const info = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!info.some((i) => i.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

ensureColumn("player", "is_whitelisted", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("player", "total_placed", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("player", "total_broken", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("home_cluster", "kind", "TEXT NOT NULL DEFAULT 'house'");
ensureColumn("container_evt", "phys_key", "TEXT");
ensureColumn("blk", "test", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("container_evt", "test", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("session_evt", "test", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("incident", "test", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("container_owner", "locked", "INTEGER NOT NULL DEFAULT 0");
// types = liste distincte des type_ids fonctionnels posés dans le chunk (union-find des clusters).
ensureColumn("chunk_stat", "types", "TEXT NOT NULL DEFAULT ''");
db.exec("CREATE INDEX IF NOT EXISTS ix_cont_phys ON container_evt(phys_key)");
// Index d'expression : l'agrégation par chunk 16x16 devient un scan limité au chunk.
db.exec("CREATE INDEX IF NOT EXISTS ix_blk_chunk ON blk(wid, (x>>4), (z>>4), action, type_id, rolled_back)");
// Fenêtre de rowid par chunk : un lot inséré se lit sans relire tout l'historique du chunk.
db.exec("CREATE INDEX IF NOT EXISTS ix_blk_chunk_row ON blk(wid, (x>>4), (z>>4), rowid)");

// FTS5 sur le chat : la création échoue si la brique n'est pas compilée.
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
      msg, content='chat_evt', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS chat_fts_ins AFTER INSERT ON chat_evt {
      INSERT INTO chat_fts(rowid, msg) VALUES (new.rowid, new.msg);
    }
    CREATE TRIGGER IF NOT EXISTS chat_fts_del AFTER DELETE ON chat_evt {
      INSERT INTO chat_fts(chat_fts, rowid, msg) VALUES ('delete', old.rowid, old.msg);
    }
  `);
  db.prepare("SELECT COUNT(*) FROM chat_fts").get();
} catch {
  db.exec("DROP TABLE IF EXISTS chat_fts");
}

// Réglages par défaut (poids/seuils) — modifiables dans l'UI.
const DEFAULT_SETTINGS: Record<string, string> = {
  weights_json: JSON.stringify({
    placed: 0.5, usage: 0.2, proximity: 0.15, netflow: 0.15, exclusive: 0.45,
    base: 40, amount_max: 30, house_bonus: 20, stranger_bonus: 15, session_bonus: 10,
    grief_base: 35, grief_amount_max: 25, tnt_base: 30, churn_base: 25, chat_base: 20,
    chat_hit_max: 15, command_base: 40,
    theft_w: 1.0, grief_w: 0.8, anomaly_w: 0.45, chat_w: 0.2,
  }),
  thresholds_json: JSON.stringify({
    home_min_blocks: 40, home_min_types: 3, territory_chunks: 25,
    owned_min_score: 0.55, public_max_score: 0.30, min_events_for_owner: 3,
    theft_alert_severity: 60, discord_min_severity: 60, composite_alert: 70,
    salvage_window_sec: 60, proximity_blocks: 32, stranger_radius: 32,
    chat_correlation_sec: 90, container_match_radius: 2,
    grief_min_blocks: 8, grief_window_sec: 300, tnt_min_blocks: 4,
    churn_min_logins: 12, churn_window_sec: 86400, churn_max_placed: 5,
  }),
  whitelist_json: JSON.stringify(["AnonyBrave"]),
  container_action_json: JSON.stringify({ deposit: 0, withdraw: 1 }),
  block_action_labels_json: JSON.stringify({ "0": "pose", "1": "casse", "2": "interact", "3": "autre" }),
  chat_watch_json: JSON.stringify({
    keywords: ["grief", "voleur", "volé", "steal", "stolen", "hack", "xray", "x-ray", "dupe"],
    commands: ["/give", "/gamemode", "/op ", "/deop", "/teleport"],
  }),
  excluded_worlds_json: JSON.stringify([]),
  // Webhook Discord : URL fournie par l'exploitant (P4), seuil propre + nom d'affichage.
  discord_json: JSON.stringify({ url: "", min_severity: 60, username: "coreprotect-watcher" }),
};

const setStmt = db.prepare("INSERT OR IGNORE INTO setting(key,value) VALUES(?,?)");
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setStmt.run(k, v);

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM setting WHERE key=?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, JSON.stringify(value));
}

export function hasFts(): boolean {
  try {
    db.prepare("SELECT COUNT(*) FROM chat_fts").get();
    return true;
  } catch {
    return false;
  }
}
