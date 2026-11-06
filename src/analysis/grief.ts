/** Détecteur de grief : destructions groupées dans les zones construites d'un autre joueur. */
import { db, getSetting } from "../db.js";
import { homeOfPoint } from "./houses.js";
import { builtNear, chatNear, sessionOpen } from "./theft.js";
import { eventKey, insertIncident, checkIncidentArgs, GRIEF_COLS } from "./cursor.js";

interface Th { [k: string]: number }
interface Wt { [k: string]: number }

function th(): Th { return getSetting("thresholds_json", {} as Th); }
function wts(): Wt { return getSetting("weights_json", {} as Wt); }

interface BreakEvent {
  rowid: number; time: number; uid: number; wid: number; x: number; y: number; z: number; type_id: number;
}

interface Run {
  uid: number;
  wid: number;
  victim_uid: number;
  cluster_id: number;
  events: BreakEvent[];
}

const fakeStmt = db.prepare("SELECT is_fake FROM player WHERE uid=?");
const whiteStmt = db.prepare("SELECT is_whitelisted FROM player WHERE uid=?");
const clusterInfo = db.prepare(
  "SELECT uid,kind,cx0*16 xmin,cx1*16+15 xmax,cz0*16 zmin,cz1*16+15 zmax FROM home_cluster WHERE id=?"
);
const nameOf = db.prepare("SELECT COALESCE(name, CAST(? AS TEXT)) n FROM material WHERE id=?");

// Cache position -> cluster : les blocs d'un cycle sont concentrés dans quelques chunks.
function clusterCacheFactory() {
  const cache = new Map<string, { uid: number; id: number } | null>();
  return (wid: number, x: number, z: number) => {
    const k = `${wid}:${x >> 4}:${z >> 4}`;
    if (!cache.has(k)) cache.set(k, homeOfPoint(wid, x, z));
    return cache.get(k)!;
  };
}

/** Regroupe les casses en salves : même joueur, même cluster, intervalle < fenêtre. */
function buildRuns(events: BreakEvent[], clustered: (wid: number, x: number, z: number) => { uid: number; id: number } | null): Run[] {
  const win = th().grief_window_sec ?? 300;
  const byKey = new Map<string, BreakEvent[]>();

  for (const e of events) {
    const c = clustered(e.wid, e.x, e.z);
    if (!c || c.uid === e.uid) continue; // pas dans une zone d'autrui
    const k = `${e.uid}|${e.wid}|${c.id}`;
    const arr = byKey.get(k) ?? [];
    arr.push(e);
    byKey.set(k, arr);
  }

  const runs: Run[] = [];
  for (const [k, arr] of byKey) {
    arr.sort((a, b) => a.time - b.time || a.rowid - b.rowid);
    const [uidS, widS, cidS] = k.split("|");
    let cur: BreakEvent[] = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].time - cur[cur.length - 1].time <= win) cur.push(arr[i]);
      else {
        runs.push({ uid: Number(uidS), wid: Number(widS), victim_uid: 0, cluster_id: Number(cidS), events: cur });
        cur = [arr[i]];
      }
    }
    runs.push({ uid: Number(uidS), wid: Number(widS), victim_uid: 0, cluster_id: Number(cidS), events: cur });
  }
  return runs;
}

/** Crée les incidents de grief. */
export function detectGrief(scanFromRowid: number): { created: number; eventsScanned: number; skipped: Record<string, number> } {
  const evs = db.prepare(
    `SELECT rowid,time,uid,wid,x,y,z,type_id FROM blk
     WHERE rowid > ? AND action=1 AND rolled_back=0 AND uid NOT NULL
     ORDER BY time, rowid`
  ).all(scanFromRowid) as BreakEvent[];

  const skipped: Record<string, number> = { fake_user: 0, whitelisted: 0, own_zone: 0 };
  const candidates: BreakEvent[] = [];
  for (const e of evs) {
    if ((fakeStmt.get(e.uid) as { is_fake: number } | undefined)?.is_fake ?? 1) { skipped.fake_user++; continue; }
    if ((whiteStmt.get(e.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) { skipped.whitelisted++; continue; }
    candidates.push(e);
  }

  const clustered = clusterCacheFactory();
  const runs = buildRuns(candidates, clustered).filter((r) => r.events.length >= (th().grief_min_blocks ?? 8));

  // Le propriétaire est lu depuis le cluster : un run sur SA zone n'est pas un grief.
  for (const r of runs) {
    r.victim_uid = (clusterInfo.get(r.cluster_id) as { uid: number } | undefined)?.uid ?? 0;
    if (r.victim_uid === r.uid) skipped.own_zone += r.events.length;
  }

  const w = wts();
  const t = th();
  const insInc = db.prepare(
    `INSERT OR IGNORE INTO incident(kind,severity,uid,wid,x,y,z,victim_uid,item_id,amount,window_start,window_end,evidence_json,status,created_at,event_rowid)
     VALUES('grief',?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`
  );

  let created = 0;
  db.transaction(() => {
    for (const r of runs) {
      if (!r.victim_uid || r.victim_uid === r.uid) continue;
      const first = r.events[0];
      const info = clusterInfo.get(r.cluster_id) as
        | { uid: number; kind: string; xmin: number; xmax: number; zmin: number; zmax: number }
        | undefined;

      const base = w.grief_base ?? 35;
      const countPart = Math.min(w.grief_amount_max ?? 25, r.events.length * 1.5);
      const ids = r.events.map((e) => e.type_id).join(",");
      const rarity = (db.prepare(`SELECT COALESCE(MAX(bonus),0) b FROM item_rarity WHERE id IN (${ids})`).get() as { b: number }).b;
      const houseBonus = info?.kind === "house" ? w.house_bonus ?? 20 : 0;
      const stranger = builtNear(r.uid, r.wid, first.x, first.z, first.time, t.stranger_radius ?? 32) ? 0 : w.stranger_bonus ?? 15;
      const sessBonus = sessionOpen(r.uid, r.events[r.events.length - 1].time) ? w.session_bonus ?? 10 : 0;
      const severity = Math.round((base + countPart + rarity + houseBonus + stranger + sessBonus) * 10) / 10;

      const evidence = {
        cluster_id: r.cluster_id,
        cluster_kind: info?.kind,
        bounds: info ? { x: [info.xmin, info.xmax], z: [info.zmin, info.zmax] } : null,
        victim_name: (db.prepare("SELECT name FROM player WHERE uid=?").get(r.victim_uid) as { name: string } | undefined)?.name,
        blocks: r.events.slice(0, 10).map((e) => ({ x: e.x, y: e.y, z: e.z, type: (nameOf.get(e.type_id, e.type_id) as { n: string }).n })),
        broken_count: r.events.length,
        event_rowids: r.events.map((e) => e.rowid),
        terms: { base, count_part: +countPart.toFixed(2), rarity_bonus: rarity, house_bonus: houseBonus, stranger_bonus: stranger, session_bonus: sessBonus },
        chat_commands: chatNear(r.uid, first.time, r.events[r.events.length - 1].time),
      };

      const res = insInc.run(
        severity, r.uid, r.wid, first.x, first.y, first.z, r.victim_uid, first.type_id,
        r.events.length, first.time, r.events[r.events.length - 1].time,
        JSON.stringify(evidence), Math.floor(Date.now() / 1000), eventKey("blk", first.rowid)
      );
      if (res.changes > 0) created++;
    }
  })();

  return { created, eventsScanned: evs.length, skipped };
}
