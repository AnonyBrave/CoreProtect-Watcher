/** Backfill complet + critères d'acceptation P0 (zéro ligne perdue vs MySQL). */
import { db } from "../db.js";
import { closePool, q } from "../mysql.js";
import { prepareSync, backfillAll } from "../sync.js";

const PAIRS: { mysql: string; sqlite: string }[] = [
  { mysql: "co_block", sqlite: "blk" },
  { mysql: "co_container", sqlite: "container_evt" },
  { mysql: "co_item", sqlite: "item_evt" },
  { mysql: "co_session", sqlite: "session_evt" },
  { mysql: "co_chat", sqlite: "chat_evt" },
  { mysql: "co_command", sqlite: "command_evt" },
];

async function main() {
  await prepareSync();
  const t0 = Date.now();
  const n = await backfillAll((s) => console.log(s));
  console.log(`[backfill] ${n} lignes en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  console.log("=== Critère P0 : zéro ligne perdue ===");
  let allOk = true;
  for (const p of PAIRS) {
    const remote = await q<{ c: number; mx: number }>(`SELECT COUNT(*) c, COALESCE(MAX(rowid),0) mx FROM \`${p.mysql}\``);
    const local = db
      .prepare(`SELECT COUNT(*) c, COALESCE(MAX(rowid),0) mx, COALESCE(MIN(rowid),0) mn FROM ${p.sqlite}`)
      .get() as { c: number; mx: number; mn: number };
    const cur = db.prepare("SELECT last_rowid FROM sync_cursor WHERE tbl=?").get(p.mysql) as { last_rowid: number };
    const ok = local.c === remote[0].c && local.mx === remote[0].mx && cur.last_rowid === remote[0].mx;
    allOk = allOk && ok;
    console.log(
      `${ok ? "OK  " : "KO  "}${p.mysql} -> ${p.sqlite}: local=${local.c} (rowid ${local.mn}..${local.mx}) mysql=${remote[0].c} (max ${remote[0].mx}) curseur=${cur.last_rowid}`
    );
  }

  console.log("=== Contrôles d'identité ===");
  const real = db.prepare("SELECT uid,name,uuid FROM player WHERE is_fake=0 ORDER BY uid").all() as {
    uid: number;
    name: string;
    uuid: string | null;
  }[];
  console.log(`joueurs réels (${real.length}):`, JSON.stringify(real));
  for (const r of real) {
    if (!r.uuid) console.log(`KO uuid manquant pour ${r.name}`);
  }
  const fake = db.prepare("SELECT COUNT(*) c FROM player WHERE is_fake=1").get() as { c: number };
  console.log(`faux utilisateurs ' #%': ${fake.c} (exclus du scoring)`);

  // Contrôle de volume identique sur un agrégat sensible.
  const ra = await q<{ a: number; b: number }>(
    "SELECT SUM(amount) a, COUNT(DISTINCT CONCAT(wid,x,y,z)) b FROM co_container"
  );
  const la = db.prepare("SELECT SUM(amount) a, COUNT(DISTINCT wid||','||x||','||y||','||z) b FROM container_evt").get() as {
    a: number;
    b: number;
  };
  console.log(`conteneurs: somme amount mysql=${ra[0].a} local=${la.a} ; boxes mysql=${ra[0].b} local=${la.b}`);

  const pages = db.pragma("page_count") as { page_count: number }[];
  const psz = db.pragma("page_size", { simple: true }) as number;
  console.log(`taille SQLite: ${((pages[0]?.page_count ?? 0) * psz / 1e6).toFixed(1)} Mo`);

  await closePool();
  console.log(allOk ? "\nP0 VALIDÉ" : "\nP0 ÉCHEC");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
