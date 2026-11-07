import { getSetting, db } from "./db.js";
import { columnsOf, metaToKv, q } from "./mysql.js";

/** Spécification de réplication : table MySQL -> table SQLite, avec les colonnes cibles. */
interface SyncSpec {
  mysqlTable: string;
  sqliteTable: string;
  cols: { out: string; from: string; default?: unknown }[];
  batch: number;
}

const BIG_TABLES: SyncSpec[] = [
  {
    mysqlTable: "co_block",
    sqliteTable: "blk",
    batch: 60000,
    cols: [
      { out: "rowid", from: "rowid" },
      { out: "time", from: "time" },
      { out: "uid", from: "user", default: null },
      { out: "wid", from: "wid" },
      { out: "x", from: "x" },
      { out: "y", from: "y" },
      { out: "z", from: "z" },
      { out: "type_id", from: "type" },
      { out: "bdata", from: "data", default: null },
      { out: "action", from: "action" },
      { out: "rolled_back", from: "rolled_back", default: 0 },
    ],
  },
  {
    mysqlTable: "co_container",
    sqliteTable: "container_evt",
    batch: 25000,
    cols: [
      { out: "rowid", from: "rowid" },
      { out: "time", from: "time" },
      { out: "uid", from: "user", default: null },
      { out: "wid", from: "wid" },
      { out: "x", from: "x" },
      { out: "y", from: "y" },
      { out: "z", from: "z" },
      { out: "item_id", from: "type" },
      { out: "amount", from: "amount", default: 1 },
      { out: "action", from: "action" },
      { out: "rolled_back", from: "rolled_back", default: 0 },
      { out: "meta", from: "metadata", default: "" },
    ],
  },
  {
    mysqlTable: "co_item",
    sqliteTable: "item_evt",
    batch: 25000,
    cols: [
      { out: "rowid", from: "rowid" },
      { out: "time", from: "time" },
      { out: "uid", from: "user", default: null },
      { out: "wid", from: "wid" },
      { out: "x", from: "x" },
      { out: "y", from: "y" },
      { out: "z", from: "z" },
      { out: "type_id", from: "type" },
      { out: "amount", from: "amount", default: 1 },
      { out: "action", from: "action" },
      { out: "rolled_back", from: "rolled_back", default: 0 },
    ],
  },
  {
    mysqlTable: "co_session",
    sqliteTable: "session_evt",
    batch: 25000,
    cols: [
      { out: "rowid", from: "rowid" },
      { out: "time", from: "time" },
      { out: "uid", from: "user", default: null },
      { out: "wid", from: "wid", default: null },
      { out: "x", from: "x", default: null },
      { out: "y", from: "y", default: null },
      { out: "z", from: "z", default: null },
      { out: "action", from: "action" },
    ],
  },
  {
    mysqlTable: "co_chat",
    sqliteTable: "chat_evt",
    batch: 25000,
    cols: [
      { out: "rowid", from: "rowid" },
      { out: "time", from: "time" },
      { out: "uid", from: "user", default: null },
      { out: "wid", from: "wid", default: null },
      { out: "x", from: "x", default: null },
      { out: "y", from: "y", default: null },
      { out: "z", from: "z", default: null },
      { out: "msg", from: "message", default: "" },
    ],
  },
  {
    mysqlTable: "co_command",
    sqliteTable: "command_evt",
    batch: 25000,
    cols: [
      { out: "rowid", from: "rowid" },
      { out: "time", from: "time" },
      { out: "uid", from: "user", default: null },
      { out: "wid", from: "wid", default: null },
      { out: "x", from: "x", default: null },
      { out: "y", from: "y", default: null },
      { out: "z", from: "z", default: null },
      { out: "cmd", from: "message", default: "" },
    ],
  },
];

const SMALL_TABLES = [
  { mysqlTable: "co_user", kind: "player" },
  { mysqlTable: "co_world", kind: "world" },
  { mysqlTable: "co_material_map", kind: "material" },
];

interface Prepared {
  spec: SyncSpec;
  insert: (rows: Record<string, unknown>[]) => void;
}

let prepared: Prepared[] = [];
let liveUsableFlag = false;

/** Nombre de tables prêtes pour la réplication MySQL (0 = mode fichiers pur). */
export function preparedCount(): number {
  return prepared.length;
}

/** La réplication live est-elle opérationnelle ? (mode auto : on bascule sur les fichiers si non) */
export function liveUsable(): boolean {
  return liveUsableFlag;
}

export async function prepareSync(): Promise<void> {
  prepared = [];
  const cursorSet = db.prepare(
    "INSERT INTO sync_cursor(tbl,last_rowid) VALUES(?,0) ON CONFLICT(tbl) DO NOTHING"
  );
  for (const spec of BIG_TABLES) {
    const have = await columnsOf(spec.mysqlTable);
    const usable = spec.cols.filter((c) => have.has(c.from));
    const selList = usable.map((c) => `${c.from} AS ${c.out}`).join(", ");
    const insCols = usable.map((c) => c.out).join(",");
    const placeholders = usable.map((c) => `@${c.out}`).join(",");
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO ${spec.sqliteTable}(${insCols}) VALUES(${placeholders})`
    );
    prepared.push({
      spec,
      insert: (rows) => {
        if (!rows.length) return;
        if (process.env.CP_DEBUG) {
          for (const r of rows) {
            for (const [k, v] of Object.entries(r)) {
              const t = typeof v;
              const ok = v === null || t === "number" || t === "string" || t === "bigint" || Buffer.isBuffer(v);
              if (!ok) throw new Error(`[debug] colonne ${spec.sqliteTable}.${k} type=${t} valeur=${String(v).slice(0, 40)}`);
            }
          }
        }
        // Une insertion par ligne dans un seul transaction (binding nommé objet).
        db.transaction(() => {
          for (const r of rows) stmt.run(r);
        })();
      },
    });
    cursorSet.run(spec.mysqlTable);
  }

  // username_log suit aussi un curseur (petite table, mais on garde l'historique complet)
  for (const t of SMALL_TABLES) {
    const have = await columnsOf(t.mysqlTable);
    if (!have.size) console.log(`[sync] table MySQL ${t.mysqlTable} absente, ignorée`);
  }

  liveUsableFlag = prepared.length > 0;
}

function cursorOf(tbl: string): number {
  const r = db.prepare("SELECT last_rowid FROM sync_cursor WHERE tbl=?").get(tbl) as
    | { last_rowid: number }
    | undefined;
  return r?.last_rowid ?? 0;
}

function setCursor(tbl: string, rowid: number, insertedDelta: number): void {
  db.prepare(
    `UPDATE sync_cursor SET last_rowid=?, last_sync_at=? , rows_total=rows_total+? WHERE tbl=?`
  ).run(rowid, Math.floor(Date.now() / 1000), insertedDelta, tbl);
}

/** Convertit les valeurs MySQL en types acceptés par SQLite. */
function coerce(v: unknown, from: string): unknown {
  if (v === undefined || v === null) return null;
  if (Buffer.isBuffer(v)) return from === "metadata" ? metaToKv(v) : v.toString("latin1");
  if (typeof v === "bigint") return v < 9007199254740991n ? Number(v) : String(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number;
}

function normalize(rows: any[], spec: SyncSpec): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const c of spec.cols) {
      const v = r[c.out];
      if (v === undefined || v === null) {
        o[c.out] = c.default ?? null;
      } else {
        o[c.out] = coerce(v, c.from);
      }
    }
    return o;
  });
}

async function fetchBatch(spec: SyncSpec, cur: number): Promise<any[]> {
  const cols = spec.cols.map((c) => `${c.from} AS ${c.out}`).join(", ");
  return q(`SELECT ${cols} FROM \`${spec.mysqlTable}\` WHERE rowid > ? ORDER BY rowid LIMIT ${spec.batch}`, [cur]);
}

/** Synchronise une grosse table par curseur rowid. */
async function syncBig(p: Prepared, opts: { fill?: boolean; log?: (s: string) => void }): Promise<number> {
  const { spec } = p;
  let cur = cursorOf(spec.mysqlTable);
  let total = 0;
  for (let guard = 0; guard < 100000; guard++) {
    const rows = await fetchBatch(spec, cur);
    if (!rows.length) break;
    p.insert(normalize(rows, spec));
    const maxRowid = Math.max(...rows.map((r) => Number(r.rowid)));
    total += rows.length;
    setCursor(spec.mysqlTable, maxRowid, rows.length);
    cur = maxRowid;
    if (opts.log && rows.length === spec.batch) opts.log(`  ${spec.mysqlTable}: +${rows.length} (curseur ${cur})`);
    if (!opts.fill) break; // cycle normal : un seul batch par table, le reste au cycle suivant
    if (rows.length < spec.batch) break;
  }
  return total;
}

/** Petites tables : refresh complet à chaque cycle. */
async function syncSmall(log?: (s: string) => void): Promise<void> {
  const users = await q<{ rowid: number; user: string; uuid: string | null }>(
    "SELECT rowid, user, uuid FROM co_user ORDER BY rowid"
  );
  const up = db.prepare(
    `INSERT INTO player(uid,uuid,name,is_fake) VALUES(?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET uuid=excluded.uuid, name=excluded.name, is_fake=excluded.is_fake`
  );
  db.transaction(() => {
    for (const u of users) up.run(u.rowid, u.uuid ?? null, u.user, u.user.startsWith("#") ? 1 : 0);
  })();

  const worlds = await q<{ id: number; world: string }>("SELECT id, world FROM co_world");
  const uw = db.prepare("INSERT INTO world(wid,name) VALUES(?,?) ON CONFLICT(wid) DO UPDATE SET name=excluded.name");
  db.transaction(() => {
    for (const w of worlds) uw.run(w.id, w.world);
  })();

  const mats = await q<{ id: number; material: string }>("SELECT id, material FROM co_material_map");
  const um = db.prepare("INSERT INTO material(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name");
  db.transaction(() => {
    for (const m of mats) um.run(m.id, m.material);
  })();

  // co_username_log : historique des noms (table passive + hook renommage futur)
  const cur = cursorOf("co_username_log");
  const ulog = await q<{ rowid: number; time: number; uuid: string; user: string }>(
    "SELECT rowid, time, uuid, user FROM co_username_log WHERE rowid > ? ORDER BY rowid",
    [cur]
  );
  if (ulog.length) {
    const u = db.prepare("INSERT OR REPLACE INTO username_log(rowid,time,uuid,user) VALUES(?,?,?,?)");
    db.transaction(() => {
      for (const r of ulog) u.run(r.rowid, r.time, r.uuid, r.user);
    })();
    setCursor("co_username_log", Math.max(...ulog.map((r) => Number(r.rowid))), ulog.length);
    if (log) log(`  co_username_log: +${ulog.length}`);
  }

  // Whitelist par défaut : applique le nom configuré sur les joueurs connus.
  const names = getSetting<string[]>("whitelist_json", ["AnonyBrave"]);
  db.prepare("UPDATE player SET is_whitelisted=0").run();
  if (names.length) {
    db.prepare(
      `UPDATE player SET is_whitelisted=1 WHERE name IN (${names.map(() => "?").join(",")})`
    ).run(...names);
  }
}

// Whitelist par défaut : appliquée sur les joueurs connus à chaque cycle.

export interface CycleResult {
  inserted: Record<string, number>;
  total: number;
}

/** Un cycle d'ingestion (cycle normal = 1 batch par table). */
export async function syncCycle(log?: (s: string) => void): Promise<CycleResult> {
  const ins: Record<string, number> = {};
  for (const p of prepared) ins[p.spec.mysqlTable] = await syncBig(p, { log });
  await syncSmall(log);
  const total = Object.values(ins).reduce((a, b) => a + b, 0);
  return { inserted: ins, total };
}

/** Backfill complet (premier lancement) jusqu'à épuisement des tables. */
export async function backfillAll(log?: (s: string) => void): Promise<number> {
  let grand = 0;
  for (const p of prepared) {
    const n = await syncBig(p, { fill: true, log });
    grand += n;
    if (log) log(`[backfill] ${p.spec.mysqlTable}: ${n} lignes`);
  }
  await syncSmall(log);
  return grand;
}

export function localCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of prepared) {
    const r = db.prepare(`SELECT COUNT(*) c FROM ${p.spec.sqliteTable}`).get() as { c: number };
    out[p.spec.sqliteTable] = r.c;
  }
  return out;
}
