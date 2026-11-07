/** Curseurs d'analyse par table source (rowid local = position d'ingestion). */
import { db } from "../db.js";

export function maxRowid(table: string): number {
  return (db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${table}`).get() as { m: number }).m;
}

/** Curseur consommé d'un détecteur. `back` reprend un peu d'historique pour les fenêtres à cheval sur deux cycles. */
export function getCursor(key: string, back = 200): number {
  const r = db.prepare("SELECT value FROM analysis_state WHERE key=?").get(key) as { value: string } | undefined;
  return Math.max(0, Number(r?.value ?? 0) - back);
}

export function setCursor(key: string, rowid: number): void {
  db.prepare(
    "INSERT INTO analysis_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, String(rowid));
}

/** Première initialisation d'un curseur : on démarre à la position courante (pas de relire l'historique). */
export function ensureCursor(key: string, rowid: number): void {
  const r = db.prepare("SELECT value FROM analysis_state WHERE key=?").get(key) as { value: string } | undefined;
  if (!r) setCursor(key, rowid);
}

/** Clef d'anti-doublon : l'index unique incident(kind,event_rowid) doit distinguer les tables sources.
 *  Les tags sont des plages disjointes (blk est négatif), donc un rowid identique dans deux tables ne fusionne pas. */
const TABLE_TAG: Record<string, number> = { container_evt: 1_000_000_000, session_evt: 2_000_000_000, chat_evt: 3_000_000_000, command_evt: 4_000_000_000, item_evt: 5_000_000_000, blk: -1_000_000_000 };

export function eventKey(table: string, rowid: number): number {
  return (TABLE_TAG[table] ?? 0) + rowid;
}

/** Colonnes d'un incident selon la nature de la preuve (le nom est un paramètre, pas une literal). */
const BASE_COLS = ["kind", "severity", "uid", "wid", "x", "y", "z"];
const TAIL_COLS = ["evidence_json", "status", "created_at", "event_rowid"];

export const THEFT_COLS = [...BASE_COLS, "victim_uid", "container_key", "item_id", "amount", "window_start", "window_end", ...TAIL_COLS];
export const GRIEF_COLS = [...BASE_COLS, "victim_uid", "item_id", "amount", "window_start", "window_end", ...TAIL_COLS];
export const TNT_COLS = [...BASE_COLS, "victim_uid", "amount", "window_start", "window_end", ...TAIL_COLS];
export const CHAT_COLS = [...BASE_COLS, "window_start", "window_end", ...TAIL_COLS];
export const CHURN_COLS = CHAT_COLS; // mêmes colonnes : churn et chat n'ont pas de victime ni conteneur.
export const DUPE_COLS = THEFT_COLS; // la duplication se lit comme un vol : même forme de preuve (conteneur, item, flux).

/** INSERT calé sur les colonnes : un seul point de construction évite les décalages placeholder/colonnes. */
export function insertIncident(columns: readonly string[]): ReturnType<typeof db.prepare> {
  const marks = columns.map(() => "?").join(",");
  return db.prepare(`INSERT OR IGNORE INTO incident(${columns.join(",")}) VALUES(${marks})`);
}

/** Le même nombre de valeurs que de colonnes, dans l'ordre des colonnes. */
export function checkIncidentArgs(columns: readonly string[], args: readonly unknown[]): void {
  if (args.length !== columns.length) {
    throw new Error(`incident : ${args.length} valeurs pour ${columns.length} colonnes (${columns.join(",")})`);
  }
}
