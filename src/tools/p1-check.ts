/** Validation P1 : maisons + propriété des conteneurs physiques sur les données réelles. */
import { db } from "../db.js";
import { refreshTypeSets, rebuildChunkStatsAll, buildHomes } from "../analysis/houses.js";
import { refreshContainers } from "../analysis/ownership.js";

function main() {
  const t0 = Date.now();
  refreshTypeSets();
  console.log(
    `types fonctionnels: ${(db.prepare("SELECT COUNT(*) c FROM functional_type").get() as { c: number }).c}, types conteneurs: ${(db.prepare("SELECT COUNT(*) c FROM container_type").get() as { c: number }).c}`
  );

  const existing = (db.prepare("SELECT COUNT(*) c FROM chunk_stat").get() as { c: number }).c;
  if (!existing) rebuildChunkStatsAll();
  else console.log(`chunk_stat déjà peuplé (${existing} lignes), pas de recomputation complète`);
  const homes = buildHomes();
  console.log(`clusters retenus: ${homes} (en ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  console.log("\n=== Clusters ===");
  for (const r of db.prepare(
    `SELECT h.uid,p.name,h.wid,w.name wname,h.kind,h.cx0*16 xmin,h.cx1*16+15 xmax,h.cz0*16 zmin,h.cz1*16+15 zmax,
            h.blocks_placed,h.functional_count,h.distinct_types
     FROM home_cluster h JOIN player p ON p.uid=h.uid JOIN world w ON w.wid=h.wid
     ORDER BY h.blocks_placed DESC LIMIT 20`
  ).all()) console.log(JSON.stringify(r));

  const t1 = Date.now();
  refreshContainers();
  console.log(`\nconteneurs physiques: ${(db.prepare("SELECT COUNT(*) c FROM phys_container WHERE orphan=0").get() as { c: number }).c}, positions d'interaction sans bloc connu (orphans): ${(db.prepare("SELECT COUNT(*) c FROM phys_container WHERE orphan=1").get() as { c: number }).c} (en ${((Date.now() - t1) / 1000).toFixed(2)} s)`);

  console.log("\n=== États de confiance ===");
  for (const r of db.prepare("SELECT trust_state,locked,COUNT(*) n FROM container_owner GROUP BY trust_state,locked").all())
    console.log(JSON.stringify(r));

  console.log("\n=== Conteneurs physiques avec owner (top volume) ===");
  for (const r of db.prepare(
    `SELECT c.key,c.x,c.y,c.z,m.name type,c.placed_uid,c.total_events,c.deposits,c.withdraws,c.volume,
            o.owner_uid,p.name owner,o.score,o.trust_state,o.locked
     FROM phys_container c JOIN container_owner o ON o.key=c.key
     LEFT JOIN player p ON p.uid=o.owner_uid LEFT JOIN material m ON m.id=c.type_id
     WHERE c.orphan=0 ORDER BY c.volume DESC LIMIT 25`
  ).all()) console.log(JSON.stringify(r));

  console.log("\n=== Joueurs & totaux ===");
  for (const r of db.prepare("SELECT uid,name,is_whitelisted,total_placed,total_broken FROM player WHERE is_fake=0").all())
    console.log(JSON.stringify(r));
}

main();
