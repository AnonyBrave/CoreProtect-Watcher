/** API HTTP de CoreProtect-Watcher (lecture sur SQLite, mutations réservées à l'admin). */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, getSetting, setSetting } from "./db.js";
import { cfg } from "./config.js";
import { addSseClient, broadcast, removeSseClient, sseCount } from "./notify.js";
import { importDir } from "./sqlimport.js";
import { squaremapConfig, squaremapWorlds, squaremapWorldSettings, squaremapPlayers } from "./squaremap.js";

function num(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const SETTING_KEYS = [
  "weights_json",
  "thresholds_json",
  "whitelist_json",
  "container_action_json",
  "block_action_labels_json",
  "chat_watch_json",
  "excluded_worlds_json",
  "discord_json",
  "item_action_json",
  "item_action_labels_json",
  "import_json",
  "squaremap_json",
];

interface ShareMemberRow {
  uid: number;
  name: string | null;
  share: number;
  score: number;
  events: number;
  deposits: number;
  withdraws: number;
  dep_vol: number;
  wdr_vol: number;
  co_owner: number;
}

interface ShareHead {
  key: string;
  wid: number;
  x: number;
  y: number;
  z: number;
  world: string | null;
  type: string | null;
  trust_state: string;
  owner_uid: number | null;
  owner_name: string | null;
  members: ShareMemberRow[];
}

interface ImportFileRow {
  file: string;
  bytes: number | null;
  mtime: number | null;
  rows: number | null;
  state: "done" | "pending" | "failed";
}

function maxRowid(table: string): number {
  return (db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${table}`).get() as { m: number }).m;
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "introuvable" });

/** Incident complet (noms inclus, preuve décodée). */
function incidentFull(id: number): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT i.*, p.name AS actor_name, v.name AS victim_name, w.name AS world_name
       FROM incident i
       LEFT JOIN player p ON p.uid=i.uid
       LEFT JOIN player v ON v.uid=i.victim_uid
       LEFT JOIN world w ON w.wid=i.wid
       WHERE i.id=?`
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...row, evidence: parseJson(row.evidence_json as string, {}) };
}

async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.headers["x-admin-token"] !== cfg.adminToken) {
    await reply.code(401).send({ error: "token d'administration invalide" });
  }
}

export function createApp(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 << 20 });

  // --- Vue d'ensemble ----------------------------------------------------
  app.get("/api/overview", () => {
    const players = db
      .prepare(
        `SELECT p.uid,p.name,p.is_whitelisted,p.total_placed,p.total_broken,
                (SELECT COUNT(*) FROM session_evt s WHERE s.uid=p.uid) sessions,
                (SELECT MAX(time) FROM session_evt s WHERE s.uid=p.uid) last_session,
                (SELECT COUNT(*) FROM container_evt e WHERE e.uid=p.uid AND e.rolled_back=0) cont_events,
                (SELECT COUNT(*) FROM incident i WHERE i.test=0 AND i.uid=p.uid) incidents_as_actor,
                (SELECT COALESCE(SUM(composite),0) FROM player_score ps WHERE ps.uid=p.uid) score
         FROM player p WHERE p.is_fake=0 ORDER BY p.total_placed DESC`
      )
      .all();

    return {
      players,
      containerStates: db
        .prepare(
          `SELECT o.trust_state,COUNT(*) n, COALESCE(SUM(c.volume),0) volume
           FROM container_owner o LEFT JOIN phys_container c ON c.key=o.key
           GROUP BY o.trust_state`
        )
        .all(),
      incidentsOpen: db
        .prepare("SELECT kind,COUNT(*) n, MAX(severity) max_sev FROM incident WHERE test=0 AND status='new' GROUP BY kind")
        .all(),
      recent: db
        .prepare(
          `SELECT i.id,i.kind,i.severity,i.status,i.created_at,i.uid,p.name actor,i.victim_uid,v.name victim,i.x,i.z,i.amount,i.wid,w.name world
           FROM incident i LEFT JOIN player p ON p.uid=i.uid LEFT JOIN player v ON v.uid=i.victim_uid LEFT JOIN world w ON w.wid=i.wid
           WHERE i.test=0 ORDER BY i.created_at DESC, i.id DESC LIMIT 12`
        )
        .all(),
      cursors: db.prepare("SELECT tbl,last_rowid,last_sync_at,rows_total FROM sync_cursor ORDER BY tbl").all(),
      lastCycleAt: (db.prepare("SELECT value FROM analysis_state WHERE key='last_cycle_at'").get() as { value: string } | undefined)?.value ?? null,
      sseClients: sseCount(),
      fakeUsers: (db.prepare("SELECT COUNT(*) c FROM player WHERE is_fake=1").get() as { c: number }).c,
    };
  });

  // --- Joueurs -----------------------------------------------------------
  app.get("/api/players", (req) => {
    const q = req.query as { q?: string; limit?: string };
    const needle = q.q ?? "";
    const limit = Math.min(200, num(q.limit, 50));
    return db
      .prepare(
        `SELECT p.uid,p.name,p.uuid,p.is_whitelisted,p.total_placed,p.total_broken,
                (SELECT MAX(time) FROM session_evt s WHERE s.uid=p.uid) last_seen,
                (SELECT COUNT(*) FROM incident i WHERE i.test=0 AND i.uid=p.uid) incidents
         FROM player p
         WHERE p.is_fake=0 AND (? = '' OR p.name LIKE '%'||?||'%')
         ORDER BY p.total_placed DESC LIMIT ?`
      )
      .all(needle, needle, limit);
  });

  app.get("/api/players/:uid", (req, reply) => {
    const uid = num((req.params as { uid: string }).uid);
    const base = db.prepare("SELECT * FROM player WHERE uid=?").get(uid);
    if (!base) return notFound(reply);

    return {
      base,
      sessions: db.prepare("SELECT time,wid,x,y,z,action FROM session_evt WHERE uid=? ORDER BY time DESC LIMIT 30").all(uid),
      usage: db
        .prepare(
          `SELECT u.key,u.deposits,u.withdraws,u.events,u.volume,u.first_time,u.last_time,
                  c.x,c.y,c.z,o.owner_uid,o.trust_state,o.locked,m.name type
           FROM usage_stat u JOIN phys_container c ON c.key=u.key
           LEFT JOIN container_owner o ON o.key=c.key LEFT JOIN material m ON m.id=c.type_id
           WHERE u.uid=? ORDER BY u.volume DESC LIMIT 60`
        )
        .all(uid),
      incidents: db
        .prepare(
          `SELECT i.id,i.kind,i.severity,i.status,i.created_at,i.victim_uid,v.name victim,i.container_key,i.amount
           FROM incident i LEFT JOIN player v ON v.uid=i.victim_uid
           WHERE i.test=0 AND (i.uid=? OR i.victim_uid=?) ORDER BY i.created_at DESC LIMIT 40`
        )
        .all(uid, uid),
      chats: db.prepare("SELECT time,wid,x,z,msg FROM chat_evt WHERE uid=? ORDER BY time DESC LIMIT 30").all(uid),
      commands: db.prepare("SELECT time,wid,x,z,cmd FROM command_evt WHERE uid=? ORDER BY time DESC LIMIT 20").all(uid),
      homes: db
        .prepare(
          `SELECT h.id,h.kind,h.wid,w.name world,cx0*16 xmin,cx1*16+15 xmax,cz0*16 zmin,cz1*16+15 zmax,
                  blocks_placed,functional_count,distinct_types
           FROM home_cluster h LEFT JOIN world w ON w.wid=h.wid WHERE h.uid=?`
        )
        .all(uid),
    };
  });

  // --- Monde (sélecteur de la carte) -------------------------------------
  app.get("/api/worlds", () => db.prepare("SELECT wid,name FROM world ORDER BY wid").all());

  // --- Scores quotidiens (graphes) -------------------------------------
  app.get("/api/scores", (req) => {
    const q = req.query as Record<string, string | undefined>;
    const uid = q.uid ? num(q.uid) : null;
    const days = Math.min(365, num(q.days, 90));
    const todayDay = Math.floor(Date.now() / 1000 / 86400);

    const rows = db
      .prepare(
        `SELECT ps.uid,p.name,ps.day,ps.theft_s,ps.grief_s,ps.anomaly_s,ps.chat_s,ps.dupe_s,ps.composite
         FROM player_score ps JOIN player p ON p.uid=ps.uid
         WHERE (? IS NULL OR ps.uid=?) AND ps.day >= ? AND p.is_fake=0
         ORDER BY ps.day`
      )
      .all(uid, uid, todayDay - days);

    return { rows, day: todayDay };
  });

  // --- Conteneurs --------------------------------------------------------
  app.get("/api/containers", (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(500, num(q.limit, 100));
    const offset = num(q.offset, 0);
    const state = q.state ?? null;
    const owner = q.owner ? num(q.owner) : null;

    return db
      .prepare(
        `SELECT c.key,c.wid,c.x,c.y,c.z,m.name type,c.orphan,c.placed_uid,
                c.total_events,c.deposits,c.withdraws,c.volume,c.first_seen,c.last_seen,
                o.owner_uid,p.name owner_name,o.score,o.trust_state,o.locked
         FROM phys_container c LEFT JOIN material m ON m.id=c.type_id
         JOIN container_owner o ON o.key=c.key LEFT JOIN player p ON p.uid=o.owner_uid
         WHERE (? IS NULL OR o.trust_state=?) AND (? IS NULL OR o.owner_uid=?)
           AND c.x BETWEEN COALESCE(?, -2147483647) AND COALESCE(?, 2147483647)
           AND c.z BETWEEN COALESCE(?, -2147483647) AND COALESCE(?, 2147483647)
         ORDER BY c.volume DESC LIMIT ? OFFSET ?`
      )
      .all(
        state,
        state,
        owner,
        owner,
        q.x0 ? num(q.x0) : null,
        q.x1 ? num(q.x1) : null,
        q.z0 ? num(q.z0) : null,
        q.z1 ? num(q.z1) : null,
        limit,
        offset
      );
  });

  // --- Copropriétaires (conteneurs partagés) --------------------------
  app.get("/api/shares", (req) => {
    const q = req.query as Record<string, string | undefined>;
    const rows = db
      .prepare(
        `SELECT s.key,s.uid,s.share,s.score,s.events,s.deposits,s.withdraws,s.dep_vol,s.wdr_vol,s.co_owner,
                p.name member_name, c.wid,c.x,c.y,c.z, w.name world, m.name type,
                o.owner_uid,o.trust_state,po.name owner_name
         FROM container_share s
         JOIN phys_container c ON c.key=s.key
         LEFT JOIN container_owner o ON o.key=s.key
         LEFT JOIN player po ON po.uid=o.owner_uid
         LEFT JOIN player p ON p.uid=s.uid
         LEFT JOIN world w ON w.wid=c.wid
         LEFT JOIN material m ON m.id=c.type_id
         WHERE ${q.key ? "s.key=?" : "1"}
         ORDER BY s.share DESC, s.events DESC`
      )
      .all(...(q.key ? [q.key] : [])) as {
        key: string; uid: number; share: number; score: number; events: number; deposits: number;
        withdraws: number; dep_vol: number; wdr_vol: number; co_owner: number; member_name: string | null;
        wid: number; x: number; y: number; z: number; world: string | null; type: string | null;
        owner_uid: number | null; trust_state: string; owner_name: string | null;
      }[];

    // regroupe les lignes de share par conteneur pour afficher la liste des co-proprietaires
    const byKey = new Map<string, ShareHead>();
    for (const r of rows) {
      const member: ShareMemberRow = {
        uid: r.uid, name: r.member_name, share: Math.round(r.share * 100) / 100, score: Math.round(r.score * 100) / 100,
        events: r.events, deposits: r.deposits, withdraws: r.withdraws, dep_vol: r.dep_vol, wdr_vol: r.wdr_vol, co_owner: r.co_owner,
      };
      const head = byKey.get(r.key);
      if (head) {
        head.members.push(member);
      } else {
        byKey.set(r.key, {
          key: r.key, wid: r.wid, x: r.x, y: r.y, z: r.z, world: r.world, type: r.type,
          trust_state: r.trust_state, owner_uid: r.owner_uid, owner_name: r.owner_name, members: [member],
        });
      }
    }
    const out = [...byKey.values()].sort((a, b) => b.members.length - a.members.length);
    return q.co ? out.filter((r) => r.members.some((m) => m.co_owner === 1)) : out;
  });

  // --- Import SQL : ledger + fichiers du dossier surveille -------------
  app.get("/api/imports", () => {
    const ledger = getSetting<Record<string, number>>("import_files_json", {} as Record<string, number>);
    const dir = importDir();
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => /\.(sql|gz)$/i.test(f));
    } catch {
      names = [];
    }
    const out: ImportFileRow[] = names.map((f) => {
      const rows = ledger[f] ?? null;
      let bytes: number | null = null;
      let mtime: number | null = null;
      try {
        const st = statSync(join(dir, f));
        bytes = st.size;
        mtime = Math.floor(st.mtimeMs / 1000);
      } catch {
        /* fichier disparu depuis le listing */
      }
      return { file: f, bytes, mtime, rows, state: rows === null ? "pending" : rows < 0 ? "failed" : "done" };
    });
    out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return { dir, files: out };
  });

  // --- SquareMap : proxy des JSON de l'instance (evite le CORS navigateur) ---
  app.get("/api/squaremap/settings", () => squaremapConfig());
  app.get("/api/squaremap/worlds", async () => {
    try {
      return await squaremapWorlds();
    } catch (e) {
      return { worlds: [], error: (e as Error).message };
    }
  });
  app.get("/api/squaremap/world/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    try {
      return await squaremapWorldSettings(name);
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  app.get("/api/squaremap/players", async () => {
    try {
      return (await squaremapPlayers()) as unknown[];
    } catch {
      return [];
    }
  });

  // --- Incidents ---------------------------------------------------------
  app.get("/api/incidents", (req) => {
    const q = req.query as Record<string, string | undefined>;
    const kind = q.kind ?? "";
    const status = q.status ?? "";
    const limit = Math.min(200, num(q.limit, 60));
    const offset = num(q.offset, 0);

    // Filtres de zone pour la carte SquareMap (bornes optionnelles + monde).
    const wid = q.wid !== undefined && q.wid !== "" ? num(q.wid) : null;
    const x0 = q.x0 !== undefined && q.x0 !== "" ? num(q.x0, -2147483647) : null;
    const x1 = q.x1 !== undefined && q.x1 !== "" ? num(q.x1, 2147483647) : null;
    const z0 = q.z0 !== undefined && q.z0 !== "" ? num(q.z0, -2147483647) : null;
    const z1 = q.z1 !== undefined && q.z1 !== "" ? num(q.z1, 2147483647) : null;

    const items = db
      .prepare(
        `SELECT i.id,i.kind,i.severity,i.status,i.note,i.created_at,i.uid,p.name actor,
                i.victim_uid,v.name victim,i.wid,w.name world,i.x,i.y,i.z,i.container_key,i.amount,i.window_start,i.window_end
         FROM incident i LEFT JOIN player p ON p.uid=i.uid LEFT JOIN player v ON v.uid=i.victim_uid
         LEFT JOIN world w ON w.wid=i.wid
         WHERE i.test=0 AND (?='' OR i.kind=?) AND (?='' OR i.status=?) AND COALESCE(i.severity,0) >= ?
           AND (? IS NULL OR i.wid=?)
           AND (COALESCE(i.x,-2147483647) BETWEEN ? AND ?)
           AND (COALESCE(i.z,-2147483647) BETWEEN ? AND ?)
         ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`
      )
      .all(kind, kind, status, status, num(q.minSeverity, 0), wid, wid, x0 ?? -2147483647, x1 ?? 2147483647, z0 ?? -2147483647, z1 ?? 2147483647, limit, offset);

    const where =
      `WHERE i.test=0 AND (?='' OR i.kind=?) AND (?='' OR i.status=?) AND COALESCE(i.severity,0) >= ?` +
      (wid !== null ? " AND i.wid=?" : "");
    const total = (db.prepare(`SELECT COUNT(*) c FROM incident i ${where}`).get(...(wid !== null ? [kind, kind, status, status, num(q.minSeverity, 0), wid] : [kind, kind, status, status, num(q.minSeverity, 0)])) as { c: number }).c;
    return { items, total };
  });

  app.get("/api/incidents/:id", (req, reply) => {
    const r = incidentFull(num((req.params as { id: string }).id));
    if (!r) return notFound(reply);
    return r;
  });

  app.post("/api/incidents/:id", { preHandler: [requireAdmin] }, async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { status?: string; note?: string };
    if (!db.prepare("SELECT id FROM incident WHERE id=?").get(id)) return notFound(reply);

    db.prepare("UPDATE incident SET status=COALESCE(?,status), note=COALESCE(?,note) WHERE id=?").run(
      body.status ?? null,
      body.note ?? null,
      id
    );
    const r = incidentFull(id);
    broadcast("incident-update", r);
    return reply.type("application/json").send(r);
  });

  // Export CSV en français (incidents réels uniquement).
  app.get("/api/export.csv", (req, reply) => {
    const kind = (req.query as { kind?: string }).kind ?? "";
    const rows = db
      .prepare(
        `SELECT i.id,i.kind,i.severity,i.status,i.created_at,p.name,v.name,i.container_key,
                i.x,i.y,i.z,i.amount,i.window_start,i.window_end,i.note
         FROM incident i LEFT JOIN player p ON p.uid=i.uid LEFT JOIN player v ON v.uid=i.victim_uid
         WHERE i.test=0 AND (?='' OR i.kind=?) ORDER BY i.created_at DESC`
      )
      .all(kind, kind) as Record<string, unknown>[];

    const head = ["id", "type", "sévérité", "statut", "créé_le", "acteur", "propriétaire", "conteneur", "x", "y", "z", "quantité", "début", "fin", "note"];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [head.join(";"), ...rows.map((r) => Object.values(r).map(esc).join(";"))].join("\n");
    return reply.header("content-type", "text/csv; charset=utf-8").send(csv);
  });

  // --- Maisons et carte ------------------------------------------------
  app.get("/api/houses", () =>
    db
      .prepare(
        `SELECT h.id,h.uid,p.name,h.kind,h.wid,w.name world,cx0*16 xmin,cx1*16+15 xmax,
                cz0*16 zmin,cz1*16+15 zmax,blocks_placed,functional_count,distinct_types,
                h.first_seen,h.last_seen
         FROM home_cluster h JOIN player p ON p.uid=h.uid LEFT JOIN world w ON w.wid=h.wid
         ORDER BY h.blocks_placed DESC LIMIT 200`
      )
      .all()
  );

  app.get("/api/map", (req) => {
    const q = req.query as Record<string, string | undefined>;
    const wid = num(q.wid, 1);
    const x0 = num(q.x0, -256), x1 = num(q.x1, 256), z0 = num(q.z0, -256), z1 = num(q.z1, 256);

    // Vue trop grande : l'UI doit découper la carte (coût de requête borné).
    if (x1 - x0 > 4096 || z1 - z0 > 4096) return { clusters: [], containers: [], chunks: [], tooWide: true };

    const clusters = db
      .prepare(
        `SELECT h.uid,p.name,h.kind,cx0*16 xmin,cx1*16+15 xmax,cz0*16 zmin,cz1*16+15 zmax,blocks_placed
         FROM home_cluster h JOIN player p ON p.uid=h.uid
         WHERE h.wid=? AND cx1*16 >= ? AND cx0*16 <= ? AND cz1*16 >= ? AND cz0*16 <= ?`
      )
      .all(wid, x0, x1, z0, z1);

    const containers = db
      .prepare(
        `SELECT c.key,c.x,c.y,c.z,m.name type,c.orphan,c.total_events,c.volume,o.owner_uid,p.name owner_name,o.score,o.trust_state
         FROM phys_container c JOIN container_owner o ON o.key=c.key
         LEFT JOIN material m ON m.id=c.type_id LEFT JOIN player p ON p.uid=o.owner_uid
         WHERE c.wid=? AND c.x BETWEEN ? AND ? AND c.z BETWEEN ? AND ? AND c.total_events > 0
         ORDER BY c.volume DESC LIMIT 1200`
      )
      .all(wid, x0, x1, z0, z1);

    const chunks = db
      .prepare(
        `SELECT cs.cx,cs.cz,cs.uid,p.name,SUM(cs.placed) placed
         FROM chunk_stat cs JOIN player p ON p.uid=cs.uid
         WHERE cs.wid=? AND cs.cx BETWEEN ? AND ? AND cs.cz BETWEEN ? AND ? AND cs.placed > 0 AND p.is_fake=0
         GROUP BY cs.cx, cs.cz ORDER BY placed DESC LIMIT 3000`
      )
      .all(wid, x0 >> 4, x1 >> 4, z0 >> 4, z1 >> 4);

    return { clusters, containers, chunks };
  });

  // --- Réglages ----------------------------------------------------------
  app.get("/api/settings", () => {
    const settings: Record<string, unknown> = {};
    for (const k of SETTING_KEYS) {
      const row = db.prepare("SELECT value FROM setting WHERE key=?").get(k) as { value: string } | undefined;
      settings[k] = parseJson(row?.value, null);
    }
    return { settings, keys: SETTING_KEYS, adminToken: cfg.adminToken };
  });

  app.post("/api/settings", { preHandler: [requireAdmin] }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const changed: string[] = [];
    for (const k of SETTING_KEYS) {
      if (body[k] !== undefined) {
        setSetting(k, body[k]);
        changed.push(k);
      }
    }
    // Le pipeline recalculera poids/seuils/whitelist au cycle suivant.
    db.prepare(
      "INSERT INTO analysis_state(key,value) VALUES('recompute_pending','1') ON CONFLICT(key) DO UPDATE SET value='1'"
    ).run();
    broadcast("settings-changed", { changed });
    return { ok: true, changed };
  });

  // --- Flux temps réel -------------------------------------------------
  app.get("/api/stream", (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const res = raw as unknown as { write: (s: string) => void; end: () => void; on: (e: string, cb: () => void) => void };
    addSseClient(res);
    req.raw.on("close", () => removeSseClient(res));
  });

  // --- Admin : pilotage du cycle ---------------------------------------
  app.post("/api/cycle/run", { preHandler: [requireAdmin] }, async () => {
    db.prepare(
      "INSERT INTO analysis_state(key,value) VALUES('recompute_pending','1') ON CONFLICT(key) DO UPDATE SET value='1'"
    ).run();
    return { ok: true, cursors: { blk: maxRowid("blk"), container: maxRowid("container_evt") } };
  });

  return app;
}
