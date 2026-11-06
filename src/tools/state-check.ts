/** Contrôle d'état après simulation : aucune ligne de test ne doit subsister. */
import { db } from "../db.js";

const counts = ["blk", "container_evt", "session_evt"].map((t) => ({
  t,
  test: (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE test=1`).get() as { n: number }).n,
}));
console.log("lignes de simulation restantes:", JSON.stringify(counts));

console.log("clusters:", JSON.stringify(db.prepare(
  "SELECT uid,kind,cx0*16 xmin,cx1*16+15 xmax,cz0*16 zmin,cz1*16+15 zmax,blocks_placed FROM home_cluster"
).all()));

console.log("joueurs:", JSON.stringify(db.prepare(
  "SELECT uid,name,total_placed,total_broken,is_whitelisted FROM player WHERE is_fake=0"
).all()));

console.log("conteneurs simulés restants:", JSON.stringify(db.prepare(
  `SELECT c.key,c.x,c.z,o.owner_uid,o.trust_state FROM phys_container c
   LEFT JOIN container_owner o ON o.key=c.key WHERE c.x>2500 OR c.x<-2500`
).all()));

console.log("blocs de test restants par joueur:", JSON.stringify(db.prepare(
  "SELECT uid,COUNT(*) n,MIN(time) tmin,MAX(time) tmax FROM blk WHERE test=1 GROUP BY uid"
).all()));

console.log("blocs dans les zones simulées:", JSON.stringify(db.prepare(
  "SELECT uid,COUNT(*) n,MIN(time) tmin,MAX(time) tmax FROM blk WHERE x>2500 OR x<-2500 GROUP BY uid"
).all()));

console.log("incidents:", JSON.stringify(db.prepare("SELECT id,kind,severity,test,status FROM incident ORDER BY id").all()));
console.log("curseurs:", JSON.stringify(db.prepare("SELECT tbl,last_rowid FROM sync_cursor ORDER BY tbl").all()));
