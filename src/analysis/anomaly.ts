/** Détecteurs d'anomalie : churn de sessions et TNT déposé dans les zones d'autrui. */
import { db, getSetting } from "../db.js";
import { homeOfPoint } from "./houses.js";
import { chatNear } from "./theft.js";
import { eventKey, insertIncident, checkIncidentArgs, TNT_COLS, CHURN_COLS } from "./cursor.js";

interface Th { [k: string]: number }
interface Wt { [k: string]: number }

function th(): Th { return getSetting("thresholds_json", {} as Th); }
function wts(): Wt { return getSetting("weights_json", {} as Wt); }

const fakeStmt = db.prepare("SELECT is_fake FROM player WHERE uid=?");
const whiteStmt = db.prepare("SELECT is_whitelisted FROM player WHERE uid=?");
const clusterInfo = db.prepare(
  "SELECT uid,kind,cx0*16 xmin,cx1*16+15 xmax,cz0*16 zmin,cz1*16+15 zmax FROM home_cluster WHERE id=?"
);

interface SessionEvent { rowid: number; time: number; uid: number; wid: number | null; x: number | null; y: number | null; z: number | null; action: number }
interface BlkEvent { rowid: number; time: number; uid: number; wid: number; x: number; y: number; z: number }

/** Churn de sessions : se reconnecter sans construire est le comportement typique du voleur qui repère. */
export function detectChurn(scanFromRowid: number): { created: number; eventsScanned: number; skipped: Record<string, number> } {
  const rows = db.prepare(
    "SELECT rowid,time,uid,wid,x,y,z,action FROM session_evt WHERE rowid > ? AND uid NOT NULL ORDER BY time, rowid"
  ).all(scanFromRowid) as SessionEvent[];

  const t = th();
  const w = wts();
  const minLogins = t.churn_min_logins ?? 12;
  const window = t.churn_window_sec ?? 86400; // une journée d'observations par joueur
  const maxPlaced = t.churn_max_placed ?? 5;

  const skipped: Record<string, number> = { fake_user: 0, whitelisted: 0, below_threshold: 0 };

  const byUid = new Map<number, SessionEvent[]>();
  for (const r of rows) {
    if ((fakeStmt.get(r.uid) as { is_fake: number } | undefined)?.is_fake ?? 1) { skipped.fake_user++; continue; }
    if ((whiteStmt.get(r.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) { skipped.whitelisted++; continue; }
    const arr = byUid.get(r.uid) ?? [];
    arr.push(r);
    byUid.set(r.uid, arr);
  }

  const insInc = insertIncident(CHURN_COLS);

  const placedCount = db.prepare(
    "SELECT COUNT(*) n FROM blk WHERE uid=? AND action=0 AND time BETWEEN ? AND ?"
  );

  let created = 0;
  for (const [uid, evs] of byUid) {
    // Segmente en fenêtres glissantes de `window` secondes.
    let i = 0;
    while (i < evs.length) {
      const startT = evs[i].time;
      const endT = startT + window;
      const seg: SessionEvent[] = [];
      while (i < evs.length && evs[i].time <= endT) seg.push(evs[i++]);
      const logins = seg.filter((e) => e.action === 0).length;
      if (logins < minLogins) { skipped.below_threshold += seg.length; continue; }

      const built = (placedCount.get(uid, startT, endT) as { n: number }).n;
      if (built > maxPlaced) { skipped.below_threshold += seg.length; continue; }

      const first = seg[0];
      const base = w.churn_base ?? 25;
      const loginPart = Math.min(w.grief_amount_max ?? 20, logins * 1.5);
      const severity = Math.round((base + loginPart) * 10) / 10;

      const evidence = {
        logins,
        logouts: seg.filter((e) => e.action === 1).length,
        blocks_placed: built,
        positions: seg.slice(0, 8).map((e) => ({ x: e.x, y: e.y, z: e.z, wid: e.wid })),
        session_rowids: seg.map((e) => e.rowid),
        terms: { base, login_part: +loginPart.toFixed(2) },
        chat_commands: chatNear(uid, startT, endT),
      };

      const vals: unknown[] = [
        "anomaly", severity, uid, first.wid, first.x, first.y, first.z, startT, seg[seg.length - 1].time,
        JSON.stringify(evidence), "new", Math.floor(Date.now() / 1000), eventKey("session_evt", first.rowid),
      ];
      checkIncidentArgs(CHURN_COLS, vals);
      const res = insInc.run(vals);
      if (res.changes > 0) created++;
    }
  }

  return { created, eventsScanned: rows.length, skipped };
}

/** TNT posé en masse dans une zone construite par un autre joueur. */
export function detectTnt(scanFromRowid: number): { created: number; eventsScanned: number; skipped: Record<string, number> } {
  const rows = db.prepare(
    `SELECT b.rowid,b.time,b.uid,b.wid,b.x,b.y,b.z FROM blk b
     JOIN material m ON m.id=b.type_id AND m.name='minecraft:tnt'
     WHERE b.rowid > ? AND b.action=0 AND b.rolled_back=0 AND b.uid NOT NULL
     ORDER BY b.time, b.rowid`
  ).all(scanFromRowid) as BlkEvent[];

  const t = th();
  const w = wts();
  const window = t.grief_window_sec ?? 300;
  const minTnt = t.tnt_min_blocks ?? 4;

  const skipped: Record<string, number> = { fake_user: 0, whitelisted: 0, wild: 0 };

  const byZone = new Map<string, BlkEvent[]>();
  for (const r of rows) {
    if ((fakeStmt.get(r.uid) as { is_fake: number } | undefined)?.is_fake ?? 1) { skipped.fake_user++; continue; }
    if ((whiteStmt.get(r.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) { skipped.whitelisted++; continue; }
    const c = homeOfPoint(r.wid, r.x, r.z);
    if (!c || c.uid === r.uid) { skipped.wild++; continue; } // hors zone d'autrui
    const k = `${r.uid}|${r.wid}|${c.id}`;
    const arr = byZone.get(k) ?? [];
    arr.push(r);
    byZone.set(k, arr);
  }

  const insInc = insertIncident(TNT_COLS);

  let created = 0;
  for (const [k, arr] of byZone) {
    if (arr.length < minTnt) continue;
    const [uidS, widS, cidS] = k.split("|");
    const uid = Number(uidS), wid = Number(widS), clusterId = Number(cidS);
    const info = clusterInfo.get(clusterId) as
      | { uid: number; kind: string; xmin: number; xmax: number; zmin: number; zmax: number }
      | undefined;
    if (!info || info.uid === uid) continue;

    arr.sort((a, b) => a.time - b.time);
    const first = arr[0];
    const base = w.tnt_base ?? 30;
    const countPart = Math.min(w.grief_amount_max ?? 25, arr.length * 2);
    const houseBonus = info.kind === "house" ? w.house_bonus ?? 20 : 0;
    const severity = Math.round((base + countPart + houseBonus) * 10) / 10;

    const evidence = {
      cluster_id: clusterId,
      cluster_kind: info.kind,
      bounds: { x: [info.xmin, info.xmax], z: [info.zmin, info.zmax] },
      victim_name: (db.prepare("SELECT name FROM player WHERE uid=?").get(info.uid) as { name: string } | undefined)?.name,
      tnt_count: arr.length,
      positions: arr.slice(0, 12).map((e) => ({ x: e.x, y: e.y, z: e.z })),
      event_rowids: arr.map((e) => e.rowid),
      terms: { base, count_part: +countPart.toFixed(2), house_bonus: houseBonus },
      chat_commands: chatNear(uid, first.time, arr[arr.length - 1].time),
    };

    const valsTnt: unknown[] = [
      "anomaly", severity, uid, wid, first.x, first.y, first.z, info.uid, arr.length,
      first.time, arr[arr.length - 1].time, JSON.stringify(evidence),
      "new", Math.floor(Date.now() / 1000), eventKey("blk", first.rowid),
    ];
    checkIncidentArgs(TNT_COLS, valsTnt);
    const res = insInc.run(valsTnt);
    if (res.changes > 0) created++;
  }

  return { created, eventsScanned: rows.length, skipped };
}
