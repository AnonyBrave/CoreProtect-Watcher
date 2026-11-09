// Lit des comptages de la base locale SQLite (lecture seule, sans bloquer le serveur).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const file = process.argv[2] ?? "C:/Users/AnonyBrave/CoreProtect-Watcher/data/coreprotect-watcher.db";
const db = new Database(file, { readonly: true });

const names = [
  "blk", "container_evt", "item_evt", "session_evt", "chat_evt", "command_evt",
  "username_log", "player", "world", "material", "chunk_stat", "home_cluster",
  "phys_container", "container_owner", "incident", "player_score", "sync_cursor", "analysis_state",
];

const out = {};
for (const t of names) {
  try {
    out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  } catch (e) {
    out[t] = String(e.message);
  }
}

out["incidents_new"] = db.prepare("SELECT COUNT(*) c FROM incident WHERE status='new' AND test=0").get().c;
out["settings_import_ledger"] = db.prepare("SELECT value FROM setting WHERE key='import_files_json'").get()?.value;
out["recompute_pending"] = db.prepare("SELECT value FROM analysis_state WHERE key='recompute_pending'").get()?.value;

console.log(JSON.stringify(out, null, 2));
