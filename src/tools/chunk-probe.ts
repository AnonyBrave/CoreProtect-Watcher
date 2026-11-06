/** Diagnostic de l'agrégation par chunk : index d'expression, types remplis, clusters éclatés. */
import { db } from "../db.js";

// 1) L'index d'expression est-il utilisé pour une sélection de chunk ?
const plan = db
  .prepare(
    "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM blk WHERE wid=1 AND (x>>4)=? AND (z>>4)=? AND action=0"
  )
  .all(-35, -14) as { detail: string }[];
console.log("plan chunk:", JSON.stringify(plan.map((p) => p.detail)));

const t0 = Date.now();
const n = (db.prepare("SELECT COUNT(*) n FROM blk WHERE wid=1 AND (x>>4)=? AND (z>>4)=?")
  .get(-35, -14) as { n: number }).n;
console.log(`blocs du chunk (-35,-14): ${n} en ${(Date.now() - t0) * 1000} ms`);

// 2) types : remplis par le rebuild complet ?
const empty = (db.prepare("SELECT COUNT(*) n FROM chunk_stat WHERE types=''").get() as { n: number }).n;
const total = (db.prepare("SELECT COUNT(*) n FROM chunk_stat").get() as { n: number }).n;
console.log(`chunk_stat: ${total} lignes, ${empty} sans types`);

// 3) Le cluster d'AnonyBrave : les chunks de son territoire sont-ils tous dans chunk_stat ?
const bbox = db.prepare("SELECT cx0,cz0,cx1,cz1 FROM home_cluster WHERE uid=1 ORDER BY blocks_placed DESC LIMIT 1").get() as
  | { cx0: number; cz0: number; cx1: number; cz1: number }
  | undefined;
console.log("gros cluster:", JSON.stringify(bbox));

const t1 = Date.now();
db.exec("CREATE INDEX IF NOT EXISTS ix_chunk_uid ON chunk_stat(uid, wid, placed)");
console.log(`index chunk_stat(uid,wid,placed): ${(Date.now() - t1) * 1000} ms`);

const t2 = Date.now();
const seeds = db.prepare("SELECT count(*) n FROM chunk_stat WHERE placed >= 40 AND uid IN (SELECT uid FROM player WHERE is_fake=0)").all() as { n: number }[];
console.log(`seeds au-dessus du seuil: ${JSON.stringify(seeds)} en ${((Date.now() - t2) / 1000).toFixed(1)} s`);

const t3 = Date.now();
db.exec("VACUUM");
console.log(`vacuum: ${((Date.now() - t3) / 1000).toFixed(1)} s`);
