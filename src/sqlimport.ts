/** Import des dumps mysqldump (tables co_*) dans le cache SQLite.
 *  Sources : fichiers .sql / .sql.gz déposés dans le dossier d'import, lus une seule fois chacun.
 *  Le parseur lit les CREATE TABLE du dump pour connaître l'ordre réel des colonnes
 *  (CoreProtect ajoute des colonnes selon les versions), puis applique la grille de mapping. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { db, getSetting, setSetting } from "./db.js";
import { cfg } from "./config.js";

type TargetCol = { out: string; names: string[]; default?: unknown };
type SourceMap = { table: string; cols: TargetCol[]; rowid: boolean };

/** Mapping canonique : table MySQL du dump -> table SQLite du cache, avec alias de colonnes. */
const MAPS: Record<string, SourceMap> = {
  co_block: {
    table: "blk",
    rowid: true,
    cols: [
      { out: "time", names: ["time"] },
      { out: "uid", names: ["user", "user_id"], default: null },
      { out: "wid", names: ["wid", "world_id"] },
      { out: "x", names: ["x", "block_x"] },
      { out: "y", names: ["y", "block_y"] },
      { out: "z", names: ["z", "block_z"] },
      { out: "type_id", names: ["type", "block_type"] },
      { out: "bdata", names: ["data", "block_data"], default: null },
      { out: "action", names: ["action"] },
      { out: "rolled_back", names: ["rolled_back"], default: 0 },
    ],
  },
  co_container: {
    table: "container_evt",
    rowid: true,
    cols: [
      { out: "time", names: ["time"] },
      { out: "uid", names: ["user", "user_id"], default: null },
      { out: "wid", names: ["wid", "world_id"] },
      { out: "x", names: ["x", "block_x"] },
      { out: "y", names: ["y", "block_y"] },
      { out: "z", names: ["z", "block_z"] },
      { out: "item_id", names: ["type", "item_type"] },
      { out: "amount", names: ["amount"], default: 1 },
      { out: "action", names: ["action"] },
      { out: "rolled_back", names: ["rolled_back"], default: 0 },
      { out: "meta", names: ["metadata", "meta"], default: "" },
    ],
  },
  co_item: {
    table: "item_evt",
    rowid: true,
    cols: [
      { out: "time", names: ["time"] },
      { out: "uid", names: ["user", "user_id"], default: null },
      { out: "wid", names: ["wid", "world_id"] },
      { out: "x", names: ["x"] },
      { out: "y", names: ["y"] },
      { out: "z", names: ["z"] },
      { out: "type_id", names: ["type", "item_type"] },
      { out: "amount", names: ["amount"], default: 1 },
      { out: "action", names: ["action"] },
      { out: "rolled_back", names: ["rolled_back"], default: 0 },
    ],
  },
  co_session: {
    table: "session_evt",
    rowid: true,
    cols: [
      { out: "time", names: ["time"] },
      { out: "uid", names: ["user", "user_id"], default: null },
      { out: "wid", names: ["wid", "world_id"], default: null },
      { out: "x", names: ["x"], default: null },
      { out: "y", names: ["y"], default: null },
      { out: "z", names: ["z"], default: null },
      { out: "action", names: ["action"] },
    ],
  },
  co_chat: {
    table: "chat_evt",
    rowid: true,
    cols: [
      { out: "time", names: ["time"] },
      { out: "uid", names: ["user", "user_id"], default: null },
      { out: "wid", names: ["wid", "world_id"], default: null },
      { out: "x", names: ["x"], default: null },
      { out: "y", names: ["y"], default: null },
      { out: "z", names: ["z"], default: null },
      { out: "msg", names: ["message", "chat"], default: "" },
    ],
  },
  co_command: {
    table: "command_evt",
    rowid: true,
    cols: [
      { out: "time", names: ["time"] },
      { out: "uid", names: ["user", "user_id"], default: null },
      { out: "wid", names: ["wid", "world_id"], default: null },
      { out: "x", names: ["x"], default: null },
      { out: "y", names: ["y"], default: null },
      { out: "z", names: ["z"], default: null },
      { out: "cmd", names: ["message", "command"], default: "" },
    ],
  },
  co_user: { table: "player", rowid: false, cols: [{ out: "uid", names: ["rowid"] }, { out: "uuid", names: ["uuid"], default: null }, { out: "name", names: ["user", "username"] }] },
  co_world: { table: "world", rowid: false, cols: [{ out: "wid", names: ["id", "rowid"] }, { out: "name", names: ["world", "name"] }] },
  co_material_map: { table: "material", rowid: false, cols: [{ out: "id", names: ["id", "rowid"] }, { out: "name", names: ["material", "value"] }] },
  co_username_log: { table: "username_log", rowid: true, cols: [{ out: "time", names: ["time"] }, { out: "uuid", names: ["uuid"], default: null }, { out: "user", names: ["user", "username"] }] },
};

type Val = string | number | Buffer | null;

function decodeMysqlString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && i + 1 < body.length) {
      const n = body[i + 1];
      switch (n) {
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "0": out += "\0"; break;
        case "Z": out += "\x1a"; break;
        default: out += n; // \\ ' " : le caractère suit l'antislash
      }
      i++;
    } else out += c;
  }
  return out;
}

function hexAt(line: string, start: number): string | null {
  let j = start;
  while (j < line.length && /[0-9a-fA-F]/.test(line[j])) j++;
  if (line[j] !== "'") return null;
  return line.slice(start, j);
}

/** Parse les tuples d'une ligne INSERT mysqldump (`VALUES (...),(...);`). On démarre après le mot VALUES : la liste de colonnes optionnelle n'est pas un tuple. */
function parseInsertTuples(line: string): Val[][] {
  const out: Val[][] = [];
  const vm = /\bVALUES\b/i.exec(line);
  let i = vm ? vm.index + 6 : line.indexOf("(");
  if (i < 0) return out;
  const n = line.length;
  while (i < n && line[i] !== "(") i++;
  if (i >= n) return out;
  while (i < n) {
    if (line[i] !== "(") break;
    i++;
    const row: Val[] = [];
    let depth = 1;
    while (i < n && depth > 0) {
      const c = line[i];
      if (c === "'" || c === '"') {
        const q = c;
        let body = "";
        i++;
        while (i < n && line[i] !== q) {
          if (line[i] === "\\" && i + 1 < n) { body += line[i] + line[i + 1]; i += 2; }
          else { body += line[i]; i++; }
        }
        i++; // fermant `q`
        row.push(decodeMysqlString(body));
      } else if (c === "X" && line[i + 1] === "'") {
        const hex = hexAt(line, i + 2);
        if (hex !== null) { row.push(Buffer.from(hex, "hex")); i += 2 + hex.length + 1; continue; }
        i++;
      } else if (c === "(") { depth++; i++; }
      else if (c === ")") { depth--; i++; }
      else if (c === ",") { i++; }
      else {
        let tok = "";
        while (i < n && line[i] !== "," && line[i] !== ")" && line[i] !== "(") { tok += line[i]; i++; }
        const t = tok.trim();
        if (!t) continue;
        if (/^NULL$/i.test(t)) row.push(null);
        else if (/^-?\d+(\.\d+)?$/.test(t)) row.push(Number(t));
        else row.push(t.replace(/`/g, ""));
      }
    }
    out.push(row);
    while (i < n && line[i] !== "(") i++;
  }
  return out;
}

function sigOf(src: string, cols: TargetCol[], row: Record<string, unknown>): string {
  return `${src}|${cols.map((c) => String(row[c.out] ?? "")).join("\u0001")}`;
}

/** Blobs du dump : metadata CoreProtect -> JSON lisible ; autres -> texte latin1. */
function decodeBlob(buf: Buffer): string {
  const toks: string[] = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x74 && buf[i + 1] === 0x00) {
      const len = buf.readUInt16BE(i + 2);
      if (len > 1 && len <= 64 && i + 4 + len <= buf.length) {
        const s = buf.toString("latin1", i + 4, i + 4 + len);
        if (/^[\x20-\x7e]+$/.test(s)) { toks.push(s); i += 3 + len; }
      }
    }
  }
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < toks.length; i += 2) pairs.push([toks[i], toks[i + 1]]);
  return JSON.stringify(pairs.length ? Object.fromEntries(pairs) : toks);
}

const sigSeen = new Set<string>();

/** Index des signatures déjà présentes dans le cache (déduplication dump / MySQL live). */
function ensureSigIndex(): void {
  if (getSetting<string>("import_sig_indexed", "0") === "1" && sigSeen.size > 0) return;
  for (const [src, map] of Object.entries(MAPS)) {
    const rows = db.prepare(`SELECT ${map.cols.map((c) => c.out).join(",")} FROM ${map.table}`).all() as Record<string, unknown>[];
    for (const r of rows) sigSeen.add(sigOf(src, map.cols, r));
  }
  setSetting("import_sig_indexed", "1");
}

function maxRowidOf(table: string): number {
  return (db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${table}`).get() as { m: number }).m;
}

/** Lit un dump (plain ou gzip) et insère uniquement les lignes inconnues. */
export function importSqlFile(file: string): Record<string, number> {
  const raw = fs.readFileSync(file);
  const text = /\.gz$/i.test(file) ? zlib.gunzipSync(raw).toString("latin1") : raw.toString("latin1");

  // Ordre réel des colonnes d'après les CREATE TABLE du dump (les contraintes ne sont pas des colonnes).
  const CONSTRAINT_WORDS = new Set(["primary", "unique", "key", "index", "foreign", "constraint", "check", "fulltext", "spatial"]);
  const colOrder: Record<string, string[]> = {};
  for (const m of text.matchAll(/CREATE\s+TABLE\s+`?(co_[a-z_]+)`?\s*\(([\s\S]*?)\)\s*(?:ENGINE|DEFAULT CHARACTER SET|;)/gi)) {
    const cols: string[] = [];
    for (const l of m[2].split("\n")) {
      const c = /^\s*`?([a-z_]+)`?\s+\w/i.exec(l.trim());
      if (c && !CONSTRAINT_WORDS.has(c[1].toLowerCase())) cols.push(c[1].toLowerCase());
    }
    colOrder[m[1]] = cols;
  }

  ensureSigIndex();
  const perTable: Record<string, number> = {};
  const stmtCache = new Map<string, { ins: (row: Record<string, unknown>, rid: number) => void; map: SourceMap }>();

  // Les dumps donnent des pseudos ; le cache veut des ids numériques. On résout les noms en joueurs (créés si absents).
  const nameSel = db.prepare("SELECT uid FROM player WHERE name=@name");
  const maxUidQ = db.prepare("SELECT COALESCE(MAX(uid),0) m FROM player");
  const insPlayerQ = db.prepare(
    "INSERT INTO player(uid,name,is_fake) VALUES(@u,@n,CASE WHEN SUBSTR(@n,1,1)='#' THEN 1 ELSE 0 END)",
  );
  const localNameMap = new Map<string, number>();
  function uidForName(name: string): number {
    const cached = localNameMap.get(name);
    if (cached !== undefined) return cached;
    const hit = nameSel.get({ name }) as { uid: number } | undefined;
    let uid = hit?.uid;
    if (uid === undefined) {
      const max = (maxUidQ.get() as { m: number }).m;
      uid = max + 1;
      insPlayerQ.run({ u: uid, n: name });
    }
    localNameMap.set(name, uid);
    return uid;
  }

  for (const line of text.split("\n")) {
    const head = /INSERT\s+INTO\s+`?(co_[a-z_]+)`?\s*(?:\(([^)]*)\))?\s*VALUES/i.exec(line);
    if (!head) continue;
    const src = head[1];
    const map = MAPS[src];
    if (!map) continue;

    const names = head[2] ? head[2].split(",").map((c) => c.trim().replace(/`/g, "").toLowerCase()) : colOrder[src];
    if (!names?.length) { console.log(`[import] ${src}: ordre des colonnes introuvable dans le dump, ignoré`); continue; }

    const tuples = parseInsertTuples(line);
    if (!tuples.length) continue;

    let cache = stmtCache.get(src);
    if (!cache) {
      const outs = map.cols.map((c) => c.out).join(",");
      const ph = map.cols.map((c) => `@${c.out}`).join(",");
      if (map.rowid) {
        const st = db.prepare(`INSERT INTO ${map.table}(rowid,${outs}) VALUES(@__rid,${ph})`);
        cache = { ins: (row, rid) => st.run({ ...row, __rid: rid }), map };
      } else if (map.table === "player") {
        const st = db.prepare(
          `INSERT INTO player(uid,uuid,name,is_fake) VALUES(@uid,@uuid,@name,CASE WHEN SUBSTR(@name,1,1)='#' THEN 1 ELSE 0 END)
           ON CONFLICT(uid) DO UPDATE SET uuid=excluded.uuid, name=excluded.name, is_fake=excluded.is_fake`,
        );
        cache = { ins: (row) => st.run(row), map };
      } else if (map.table === "world") {
        const st = db.prepare("INSERT INTO world(wid,name) VALUES(@wid,@name) ON CONFLICT(wid) DO UPDATE SET name=excluded.name");
        cache = { ins: (row) => st.run(row), map };
      } else {
        const st = db.prepare("INSERT INTO material(id,name) VALUES(@id,@name) ON CONFLICT(id) DO UPDATE SET name=excluded.name");
        cache = { ins: (row) => st.run(row), map };
      }
      stmtCache.set(src, cache);
    }

    let nextRid = maxRowidOf(map.table) + 1;
    db.transaction(() => {
      for (const t of tuples) {
        if (t.length !== names.length) continue; // ligne tronquée : on la saute
        const row: Record<string, unknown> = {};
        let missing = false;
        for (const c of map.cols) {
          const p = names.findIndex((nm) => c.names.includes(nm));
          if (p < 0) { missing = true; continue; }
          const v = t[p];
          if (c.out === "uid" && typeof v === "string") { row[c.out] = uidForName(v); continue; }
          row[c.out] = v === null ? c.default ?? null : Buffer.isBuffer(v) ? decodeBlob(v) : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
        }
        if (missing) continue;
        const sig = sigOf(src, map.cols, row);
        if (sigSeen.has(sig)) continue; // ligne déjà ingérée (MySQL live ou autre dump)
        sigSeen.add(sig);
        cache!.ins(row, nextRid++);
        perTable[src] = (perTable[src] ?? 0) + 1;
      }
    })();
  }

  return perTable;
}

/** Dossier d'import : CP_IMPORT_DIR (défaut data/imports), modifiable dans Réglages. */
export function importDir(): string {
  const s = getSetting<{ dir?: string }>("import_json", {} as { dir?: string });
  return path.resolve(s.dir ?? cfg.importDir);
}

/** Importe les fichiers non encore traités (marqués en setting import_files_json). */
export function importPending(log?: (s: string) => void): Record<string, number> {
  const dir = importDir();
  fs.mkdirSync(dir, { recursive: true });
  const done = getSetting<Record<string, number>>("import_files_json", {} as Record<string, number>);
  const files = fs.readdirSync(dir).filter((f) => /\.(sql|gz)$/i.test(f)).sort();
  const totals: Record<string, number> = {};
  for (const f of files) {
    if (done[f]) continue;
    const t0 = Date.now();
    let res: Record<string, number>;
    try {
      res = importSqlFile(path.join(dir, f));
    } catch (e) {
      console.error(`[import] ${f}: échec ${(e as Error).message}`);
      done[f] = -1;
      setSetting("import_files_json", done);
      continue;
    }
    const total = Object.values(res).reduce((a, b) => a + b, 0);
    done[f] = total;
    setSetting("import_files_json", done);
    if (log) log(`[import] ${f}: ${total} nouvelles lignes en ${Date.now() - t0} ms (${JSON.stringify(res)})`);
    for (const [k, v] of Object.entries(res)) totals[k] = (totals[k] ?? 0) + v;
  }
  return totals;
}
