/** Outil de validation P0 : ingestion d'un batch + contrôles d'identité. */
import { db } from "../db.js";
import { closePool } from "../mysql.js";
import { prepareSync, syncCycle, localCounts } from "../sync.js";

async function main() {
  const t0 = Date.now();
  await prepareSync();
  const res = await syncCycle((s) => console.log(s));
  console.log(`durée cycle: ${Date.now() - t0} ms`);
  console.log("insérées ce cycle:", JSON.stringify(res.inserted));
  console.log("comptes locaux:", JSON.stringify(localCounts()));

  const players = db
    .prepare("SELECT uid,name,uuid,is_fake FROM player ORDER BY uid")
    .all();
  const real = players.filter((p: any) => !p.is_fake);
  console.log("joueurs réels:", JSON.stringify(real));
  console.log("faux utilisateurs exclus:", players.filter((p: any) => p.is_fake).length);

  const cursors = db.prepare("SELECT tbl,last_rowid,rows_total FROM sync_cursor ORDER BY tbl").all();
  console.log("curseurs:", JSON.stringify(cursors));
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
