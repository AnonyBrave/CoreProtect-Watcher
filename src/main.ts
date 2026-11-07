/** Point d'entrée : ingestion MySQL -> SQLite, analyse incrémentale, API HTTP + UI. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import FastifyCors from "@fastify/cors";
import { cfg, DIST_DIR } from "./config.js";
import { db } from "./db.js";
import { prepareSync, syncCycle, backfillAll, preparedCount, liveUsable } from "./sync.js";
import { importPending, importDir } from "./sqlimport.js";
import { recomputeAll, cycleIncremental, initCursors } from "./pipeline.js";
import { broadcast, notifyIncident } from "./notify.js";
import { createApp } from "./api.js";

function log(s: string): void {
  console.log(`[${new Date().toLocaleTimeString("fr-FR")}] ${s}`);
}

function maxRowid(table: string): number {
  return (db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${table}`).get() as { m: number }).m;
}

export function stateGet(key: string, def = "0"): string {
  const r = db.prepare("SELECT value FROM analysis_state WHERE key=?").get(key) as { value: string } | undefined;
  return r?.value ?? def;
}

export function stateSet(key: string, value: string): void {
  db.prepare(
    "INSERT INTO analysis_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, value);
}

/** Consomme la demande de recomputation complète (réglages modifiés, premier lancement). */
function consumeRecomputeFlag(): boolean {
  const r = db.prepare("SELECT value FROM analysis_state WHERE key='recompute_pending'").get() as
    | { value: string }
    | undefined;
  if (r?.value !== "1") return false;
  db.prepare("DELETE FROM analysis_state WHERE key='recompute_pending'").run();
  return true;
}

/** Diffuse les incidents créés pendant ce cycle (les cas de simulation sont exclus du flux). */
function publishIncidents(ids: number[]): void {
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT i.id,i.kind,i.severity,i.uid,i.victim_uid,p.name,v.name victim_name,
              i.x,i.y,i.z,i.container_key,i.amount,i.window_start,i.window_end
       FROM incident i LEFT JOIN player p ON p.uid=i.uid LEFT JOIN player v ON v.uid=i.victim_uid
       WHERE i.test=0 AND i.id IN (${marks}) ORDER BY i.id`
    )
    .all(...ids) as {
      id: number; kind: string; severity: number; uid: number | null; victim_uid: number | null;
      name: string | null; victim_name: string | null; x: number | null; y: number | null; z: number | null;
      container_key: string | null; amount: number | null; window_start: number | null; window_end: number | null;
    }[];

  for (const i of rows) {
    broadcast("incident", i);
    void notifyIncident(i);
  }
}

let lastFullAt = 0;

/** Un cycle : import des dumps si nécessaire, ingestion MySQL live si disponible, puis analyse. */
async function runStep(): Promise<void> {
  const beforeBlk = maxRowid("blk");
  const beforeCont = maxRowid("container_evt");

  // Dossiers de dump SQL (CP_SOURCE=files ou auto ; 'mysql' pur n'importe jamais).
  let importedTotal = 0;
  if (cfg.cpSource !== "mysql") {
    const res = importPending(log);
    for (const t of Object.values(res)) importedTotal += t;
    // Des lignes importées touchent conteneurs, flux et propriété : tout est à recalculer.
    if (importedTotal) stateSet("recompute_pending", "1");
  }

  let ins = { inserted: {} as Record<string, number>, total: 0 };
  if (cfg.cpSource !== "files" && liveUsable()) {
    ins = await syncCycle();
  }

  const full = consumeRecomputeFlag() || (lastFullAt && Date.now() / 1000 - lastFullAt >= cfg.fullRecomputeMinutes * 60);
  if (full) {
    recomputeAll();
    lastFullAt = Date.now() / 1000;
    log("[recompute] complète terminée");
  }

  const out = cycleIncremental(beforeBlk, beforeCont);
  publishIncidents(out.incidentsNew);
  stateSet("last_cycle_at", String(Math.floor(Date.now() / 1000)));

  if (ins.total || importedTotal || out.chunksTouched || out.physContainersNew || out.eventsScanned) {
    const kinds = Object.entries(out.byKind).map(([k, n]) => `${k}=${n}`).join(" ");
    log(
      `[cycle] +${ins.total} lignes MySQL, +${importedTotal} importées, ${out.chunksTouched} chunks, ` +
        `${out.physContainersNew} conteneurs, ${out.eventsScanned} événements scannés, ` +
        `${out.incidentsNew.length} incidents ${kinds}`
    );
  }
  broadcast("cycle", {
    inserted: ins.total,
    imported: importedTotal,
    chunksTouched: out.chunksTouched,
    physContainersNew: out.physContainersNew,
    eventsScanned: out.eventsScanned,
    incidentsNew: out.incidentsNew.length,
    byKind: out.byKind,
    at: Math.floor(Date.now() / 1000),
  });
}

async function boot(): Promise<void> {
  const source = cfg.cpSource;
  let live = false;
  if (source !== "files") {
    try {
      await prepareSync();
      live = preparedCount() > 0;
      log(`[sync] ${live ? "réplication MySQL prête" : "aucune table MySQL exploitable"} (CP_SOURCE=${source})`);
    } catch (e) {
      log(`[sync] MySQL indisponible : ${(e as Error).message}`);
      if (source === "mysql") throw e; // 'mysql' exige la base live ; 'auto' bascule sur les fichiers SQL.
    }
  }

  const rows = (db.prepare("SELECT COUNT(*) c FROM blk").get() as { c: number }).c;
  if (!rows) {
    let n = 0;
    if (live && source !== "files") {
      log("[backfill] premier lancement, copie complète depuis MySQL…");
      n += await backfillAll(log);
    }
    if (source !== "mysql") {
      log(`[import] dumps SQL depuis ${importDir()}…`);
      const res = importPending(log);
      for (const t of Object.values(res)) n += t;
    }
    log(`[backfill] terminé : ${n} lignes`);
  }

  // Premier cycle : recomputation lourde (chunk_stat, clusters, conteneurs, propriété, copropriétaires).
  stateSet("recompute_pending", "1");
  initCursors(); // les détecteurs démarrent à la position courante d'ingestion

  const app = createApp();
  await app.register(FastifyCors, { origin: true });
  if (existsSync(path.join(DIST_DIR, "index.html"))) {
    await app.register(fastifyStatic, { root: DIST_DIR, index: "index.html", wildcard: false });
  }
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api")) return reply.code(404).send({ error: "introuvable" });
    const idx = path.join(DIST_DIR, "index.html");
    if (existsSync(idx)) return reply.type("text/html").send(readFileSync(idx));
    return reply.type("text/html").send(
      "<!doctype html><meta charset='utf-8'><h1>CoreProtect-Watcher</h1>" +
        "<p>L'interface n'est pas construite. Lancez <code>npm run build:web</code> puis rechargez.</p>"
    );
  });

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  log(`[api] CoreProtect-Watcher écoute sur http://localhost:${cfg.port}`);

  for (;;) {
    try {
      await runStep();
    } catch (e) {
      log(`[cycle] échec : ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.ingestSeconds * 1000));
  }
}

process.on("SIGINT", () => {
  log("[arrêt] demandé");
  process.exit(0);
});

boot().catch((e) => {
  console.error("[démarrage] échec :", (e as Error).message);
  process.exit(1);
});
