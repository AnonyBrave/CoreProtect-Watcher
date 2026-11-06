/** Mesure des coûts de reconstruction (chunk_stat delta, clusters) après index d'expression. */
import { db } from "../db.js";
import { refreshTypeSets, rebuildChunkStatsAll, buildHomes, refreshChunkDelta } from "../analysis/houses.js";

function maxRowid(t: string): number {
  return (db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${t}`).get() as { m: number }).m;
}

const t0 = Date.now();
refreshTypeSets();
rebuildChunkStatsAll();
console.log(`chunk_stat complet: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const t1 = Date.now();
const n = buildHomes();
console.log(`buildHomes: ${n} clusters en ${((Date.now() - t1) / 1000).toFixed(2)} s`);

console.log(
  "clusters:",
  JSON.stringify(
    db.prepare(
      "SELECT uid,kind,cx0*16 xmin,cx1*16+15 xmax,cz0*16 zmin,cz1*16+15 zmax,blocks_placed,distinct_types FROM home_cluster ORDER BY blocks_placed DESC LIMIT 8"
    ).all()
  )
);

// Delta sur un lot réaliste (dernières 60 000 lignes de blocs).
const win = maxRowid("blk") - 60000;
const t2 = Date.now();
const touched = refreshChunkDelta(win);
console.log(`refreshChunkDelta(60k lignes): ${touched.size} chunks en ${((Date.now() - t2) / 1000).toFixed(2)} s`);

// Restauration des compteurs (le delta appliqué par-dessus le complet les gonfle).
const t3 = Date.now();
rebuildChunkStatsAll();
buildHomes();
console.log(`restauration: ${((Date.now() - t3) / 1000).toFixed(1)} s`);

console.log(
  "joueurs:",
  JSON.stringify(db.prepare("SELECT uid,name,total_placed,total_broken FROM player WHERE is_fake=0").all())
);
console.log(
  "gros clusters:",
  JSON.stringify(
    db.prepare(
      "SELECT uid,kind,cx0*16 xmin,cx1*16+15 xmax,cz0*16 zmin,cz1*16+15 zmax,blocks_placed,distinct_types FROM home_cluster ORDER BY blocks_placed DESC LIMIT 4"
    ).all()
  )
);
