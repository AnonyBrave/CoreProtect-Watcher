/** Maisons = clusters de blocs posés (chunk 16x16 fusionnés), faux utilisateurs exclus. */
import { db, getSetting } from "../db.js";

const FUNCTIONAL_PATTERNS = [
  "minecraft:chest",
  "minecraft:trapped_chest",
  "%barrel%",
  "%shulker_box",
  "%_door",
  "%_trapdoor",
  "%bed%",
  "%torch",
  "minecraft:furnace",
  "minecraft:blast_furnace",
  "minecraft:smoker",
  "minecraft:crafting_table",
  "minecraft:ladder",
  "minecraft:glass_pane",
  "%lantern",
  "minecraft:campfire",
  "minecraft:enchanting_table",
  "minecraft:bookshelf",
  "minecraft:anvil",
  "%fence_gate",
  "%pressure_plate",
  "minecraft:lever",
];

const CONTAINER_PATTERNS = ["minecraft:chest", "minecraft:trapped_chest", "%barrel%", "%shulker_box"];

function fillTypes(table: string, patterns: string[]) {
  db.exec(`DELETE FROM ${table}`);
  const where = patterns.map((p) => `name LIKE '${p}'`).join(" OR ");
  db.exec(
    `INSERT INTO ${table}(id) SELECT id FROM material WHERE ${where} AND NOT (name LIKE 'minecraft:redstone_torch')`
  );
}

export function refreshTypeSets(): void {
  fillTypes("functional_type", FUNCTIONAL_PATTERNS);
  fillTypes("container_type", CONTAINER_PATTERNS);
}

/** Recomputation complète des stats de chunk (utilisée au premier lancement). */
export function rebuildChunkStatsAll(): void {
  const t0 = Date.now();
  db.exec("DELETE FROM chunk_stat");
  db.prepare(
    `INSERT INTO chunk_stat(uid,wid,cx,cz,placed,broken,functional,first_time,last_time,types)
     SELECT uid, wid, x>>4, z>>4,
       SUM(CASE WHEN action=0 AND rolled_back=0 THEN 1 ELSE 0 END),
       SUM(CASE WHEN action=1 AND rolled_back=0 THEN 1 ELSE 0 END),
       SUM(CASE WHEN action=0 AND rolled_back=0 AND type_id IN (SELECT id FROM functional_type) THEN 1 ELSE 0 END),
       MIN(time), MAX(time),
       COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN action=0 AND rolled_back=0 AND type_id IN (SELECT id FROM functional_type) THEN type_id END), '')
     FROM blk
     WHERE uid NOT NULL AND uid IN (SELECT uid FROM player WHERE is_fake=0)
     GROUP BY wid, x>>4, z>>4, uid`
  ).run();
  console.log(`[houses] chunk_stat complet en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

interface Delta {
  placed: number;
  broken: number;
  functional: number;
  tmin: number;
  tmax: number;
  types: Set<string>;
}

function realUidSet(): Set<number> {
  return new Set(
    (db.prepare("SELECT uid FROM player WHERE is_fake=0").all() as { uid: number }[]).map((r) => r.uid)
  );
}

function functionalIdSet(): Set<number> {
  return new Set((db.prepare("SELECT id FROM functional_type").all() as { id: number }[]).map((r) => r.id));
}

/** Agrège les blocs insérés depuis un rowid et applique les deltas à chunk_stat (coût = taille du lot). */
export function refreshChunkDelta(sinceRowid: number): Set<string> {
  const rows = db
    .prepare(
      "SELECT uid, wid, x>>4 AS cx, z>>4 AS cz, action, type_id, time FROM blk WHERE rowid > ? AND rolled_back=0"
    )
    .all(sinceRowid) as { uid: number; wid: number; cx: number; cz: number; action: number; type_id: number; time: number }[];

  const real = realUidSet();
  const func = functionalIdSet();
  const agg = new Map<string, Delta>();

  for (const r of rows) {
    if (r.uid === null || !real.has(r.uid)) continue;
    const k = `${r.wid}:${r.cx}:${r.cz}:${r.uid}`;
    let d = agg.get(k);
    if (!d) {
      d = { placed: 0, broken: 0, functional: 0, tmin: Infinity, tmax: -Infinity, types: new Set() };
      agg.set(k, d);
    }
    if (r.action === 0) {
      d.placed++;
      if (func.has(r.type_id)) {
        d.functional++;
        d.types.add(String(r.type_id));
      }
    } else if (r.action === 1) d.broken++;
    d.tmin = Math.min(d.tmin, r.time);
    d.tmax = Math.max(d.tmax, r.time);
  }

  const readTypes = db.prepare("SELECT types FROM chunk_stat WHERE wid=? AND cx=? AND cz=? AND uid=?");
  const upsert = db.prepare(
    `INSERT INTO chunk_stat(uid,wid,cx,cz,placed,broken,functional,first_time,last_time,types)
     VALUES(@uid,@wid,@cx,@cz,@placed,@broken,@functional,@tmin,@tmax,@types)
     ON CONFLICT(wid,cx,cz,uid) DO UPDATE SET
       placed=chunk_stat.placed + excluded.placed,
       broken=chunk_stat.broken + excluded.broken,
       functional=chunk_stat.functional + excluded.functional,
       first_time=MIN(chunk_stat.first_time, excluded.first_time),
       last_time=MAX(chunk_stat.last_time, excluded.last_time),
       types=excluded.types`
  );

  db.transaction(() => {
    for (const [k, d] of agg) {
      const [widS, cxS, czS, uidS] = k.split(":");
      const wid = Number(widS), cx = Number(cxS), cz = Number(czS), uid = Number(uidS);
      // Union des types déjà connus dans le chunk (types est un ensemble persistant).
      const prev = ((readTypes.get(wid, cx, cz, uid) as { types: string } | undefined)?.types ?? "").split(",");
      const merged = new Set([...prev.filter(Boolean), ...d.types]);
      upsert.run({
        uid,
        wid,
        cx,
        cz,
        placed: d.placed,
        broken: d.broken,
        functional: d.functional,
        tmin: Number.isFinite(d.tmin) ? d.tmin : null,
        tmax: Number.isFinite(d.tmax) ? d.tmax : null,
        types: [...merged].join(","),
      });
    }
  })();

  // Les chunks touchés (sans la dimension joueur).
  const chunks = new Set<string>();
  for (const k of agg.keys()) {
    const [wid, cx, cz] = k.split(":");
    chunks.add(`${wid}:${cx}:${cz}`);
  }
  return chunks;
}

/** Rafraîchit des chunks à partir de tout leur historique (zones peu remplies : nettoyage de simulation). */
export function refreshChunkStats(chunks: Set<string>): void {
  if (!chunks.size) return;
  const stmt = db.prepare(
    `INSERT INTO chunk_stat(uid,wid,cx,cz,placed,broken,functional,first_time,last_time,types)
     SELECT uid, wid, x>>4, z>>4,
       SUM(CASE WHEN action=0 AND rolled_back=0 THEN 1 ELSE 0 END),
       SUM(CASE WHEN action=1 AND rolled_back=0 THEN 1 ELSE 0 END),
       SUM(CASE WHEN action=0 AND rolled_back=0 AND type_id IN (SELECT id FROM functional_type) THEN 1 ELSE 0 END),
       MIN(time), MAX(time),
       COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN action=0 AND rolled_back=0 AND type_id IN (SELECT id FROM functional_type) THEN type_id END), '')
     FROM blk WHERE wid=@wid AND x BETWEEN @x0 AND @x1 AND z BETWEEN @z0 AND @z1
       AND uid NOT NULL AND uid IN (SELECT uid FROM player WHERE is_fake=0)
     GROUP BY uid, x>>4, z>>4
     ON CONFLICT(wid,cx,cz,uid) DO UPDATE SET
       placed=excluded.placed, broken=excluded.broken, functional=excluded.functional,
       first_time=MIN(chunk_stat.first_time, excluded.first_time),
       last_time=MAX(chunk_stat.last_time, excluded.last_time),
       types=excluded.types`
  );
  db.transaction(() => {
    for (const c of chunks) {
      const [widS, cxS, czS] = c.split(":");
      const wid = Number(widS);
      const cx = Number(cxS);
      const cz = Number(czS);
      stmt.run({ wid, cx, cz, x0: cx * 16, x1: cx * 16 + 15, z0: cz * 16, z1: cz * 16 + 15 });
    }
  })();
}

interface Seed {
  uid: number;
  wid: number;
  cx: number;
  cz: number;
  placed: number;
  types: string; // type_ids fonctionnels distincts posés dans le chunk (CSV)
}

/** Fusion des chunks contigus au-dessus du seuil -> clusters de maison. */
export function buildHomes(): number {
  const th = getSetting("thresholds_json", {} as Record<string, number>);
  const minBlocks = th.home_min_blocks ?? 40;
  const minTypes = th.home_min_types ?? 3;

  const seeds = db
    .prepare(
      `SELECT uid, wid, cx, cz, placed, types FROM chunk_stat
       WHERE placed >= ? AND uid IN (SELECT uid FROM player WHERE is_fake=0)`
    )
    .all(minBlocks) as Seed[];

  // Union-find sur l'adjacence (8 voisins) pour un même joueur / monde.
  const parent = new Map<string, string>();
  const keyOf = (s: { uid: number; wid: number; cx: number; cz: number }) => `${s.uid}:${s.wid}:${s.cx}:${s.cz}`;
  for (const s of seeds) parent.set(keyOf(s), keyOf(s));
  function find(a: string): string {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // compression de chemin
    let cur = a;
    while (parent.get(cur) !== r) {
      const nxt = parent.get(cur)!;
      parent.set(cur, r);
      cur = nxt;
    }
    return r;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const seedSet = new Set(seeds.map(keyOf));
  for (const s of seeds) {
    const k = keyOf(s);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nk = `${s.uid}:${s.wid}:${s.cx + dx}:${s.cz + dz}`; // même joueur/monde, chunk voisin
        if (seedSet.has(nk)) union(k, nk);
      }
  }

  const groups = new Map<string, Seed[]>();
  for (const s of seeds) {
    const r = find(keyOf(s));
    const arr = groups.get(r) ?? [];
    arr.push(s);
    groups.set(r, arr);
  }

  db.exec("DELETE FROM home_cluster");
  const ins = db.prepare(
    `INSERT INTO home_cluster(uid,wid,cx0,cz0,cx1,cz1,blocks_placed,functional_count,distinct_types,first_seen,last_seen,center_x,center_z,kind)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const statStmt = db.prepare(
    `SELECT SUM(placed) placed, SUM(functional) func, MIN(first_time) ft, MAX(last_time) lt
     FROM chunk_stat WHERE uid=? AND wid=? AND cx BETWEEN ? AND ? AND cz BETWEEN ? AND ?`
  );

  let created = 0;
  for (const g of groups.values()) {
    const cx0 = Math.min(...g.map((s) => s.cx));
    const cz0 = Math.min(...g.map(s => s.cz));
    const cx1 = Math.max(...g.map(s => s.cx));
    const cz1 = Math.max(...g.map(s => s.cz));
    const uid = g[0].uid;
    const wid = g[0].wid;
    // Cluster retenu si ≥ N blocs posés ET ≥ M types fonctionnels distincts.
    const st = statStmt.get(uid, wid, cx0, cx1, cz0, cz1) as { placed: number; func: number; ft: number; lt: number };
    // Types distincts : union des listes de chunks (liste déjà agrégée dans chunk_stat).
    const typeSet = new Set<string>();
    for (const s of g) for (const t of s.types.split(",")) if (t) typeSet.add(t);
    const dt = typeSet.size;
    if ((st.placed ?? 0) < minBlocks || dt < minTypes) continue;
    const extentChunks = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
    const kind = extentChunks > (th.territory_chunks ?? 25) ? "territory" : "house";
    ins.run(
      uid,
      wid,
      cx0,
      cz0,
      cx1,
      cz1,
      st.placed,
      st.func,
      dt,
      st.ft,
      st.lt,
      ((cx0 + cx1) * 16 + 8) / 2,
      ((cz0 + cz1) * 16 + 8) / 2,
      kind
    );
    created++;
  }

  // Totaux d'activité par joueur.
  db.prepare(
    `UPDATE player SET total_placed=(SELECT COALESCE(SUM(placed),0) FROM chunk_stat cs WHERE cs.uid=player.uid),
                        total_broken =(SELECT COALESCE(SUM(broken),0) FROM chunk_stat cs WHERE cs.uid=player.uid)`
  ).run();

  return created;
}

/** Distance (en blocs) entre un point et la maison la plus proche du joueur. */
export function distanceToHome(uid: number, wid: number, x: number, z: number): number | null {
  const homes = db
    .prepare("SELECT center_x cx, center_z cz, cx0*16 xmin, cx1*16+15 xmax, cz0*16 zmin, cz1*16+15 zmax FROM home_cluster WHERE uid=? AND wid=?")
    .all(uid, wid) as { cx: number; cz: number; xmin: number; xmax: number; zmin: number; zmax: number }[];
  if (!homes.length) return null;
  let best = Infinity;
  for (const h of homes) {
    const dx = Math.max(h.xmin - x, 0, x - h.xmax);
    const dz = Math.max(h.zmin - z, 0, z - h.zmax);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/** Cluster qui contient la position (cluster le plus petit d'abord : maison plutôt que territoire). */
export function homeOfPoint(wid: number, x: number, z: number): { uid: number; id: number } | null {
  const row = db
    .prepare(
      `SELECT id, uid FROM home_cluster
       WHERE wid=? AND ? BETWEEN cx0*16 AND cx1*16+15 AND ? BETWEEN cz0*16 AND cz1*16+15
       ORDER BY (cx1-cx0)*(cz1-cz0) LIMIT 1`
    )
    .get(wid, Math.floor(x), Math.floor(z)) as { id: number; uid: number } | undefined;
  return row ? { uid: row.uid, id: row.id } : null;
}
