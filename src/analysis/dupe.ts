/** Détecteur de duplication (dupe) : trois signatures confirmées par l'exploitant.
 *  1. Conteneur copié/re-posé : cycle casse -> re-pose rapide du même joueur, avec un déficit
 *     de flux net sur le conteneur (retraits >> dépôts = items sortis sans remise de copie).
 *  2. Items au sol créés sans source : ramassages >> (dépôts au sol + poses) d'un même joueur,
 *     par type d'item et sur une fenêtre. Les codes d'action co_item sont configurables.
 *  3. Clones de chunk (crash / téléport) : re-création massive aux mêmes coordonnées par le même
 *     joueur dans un autre monde, en fenêtre courte.
 *  Les hoppers/panneaux/redstone ne sont pas des signatures : on ne surveille que ces trois motifs. */
import { db, getSetting } from "../db.js";
import { eventKey, insertIncident, checkIncidentArgs, getCursor, setCursor, DUPE_COLS } from "./cursor.js";

interface Th { [k: string]: number }
interface Wt { [k: string]: number }

function th(): Th { return getSetting("thresholds_json", {} as Th); }
function wts(): Wt { return getSetting("weights_json", {} as Wt); }

/** Codes d'action co_item (listes configurables : la sémantique varie selon les versions de CoreProtect). */
interface ItemAct { drop: number[]; pickup: number[]; spawn: number[] }
function itemActs(): ItemAct {
  const a = getSetting("item_action_json", { drop: [0], pickup: [1, 2], spawn: [3] } as Record<string, number[]>);
  return { drop: a.drop ?? [0], pickup: a.pickup ?? [1, 2], spawn: a.spawn ?? [3] };
}

const fakeStmt = db.prepare("SELECT is_fake FROM player WHERE uid=?");
const whiteStmt = db.prepare("SELECT is_whitelisted FROM player WHERE uid=?");
const nameOf = db.prepare("SELECT COALESCE(name, CAST(? AS TEXT)) n FROM material WHERE id=?");

interface PlaceEvent { rowid: number; time: number; uid: number; wid: number; x: number; y: number; z: number; type_id: number }
interface ItemEvent { rowid: number; time: number; uid: number; wid: number; x: number; y: number; z: number; type_id: number; amount: number; action: number }

/** Flux net d'un conteneur : volume déposé / retiré (la copie se lit par le déficit). */
function containerFlux(key: string): { dep_vol: number; wdr_vol: number } {
  const DEP = getSetting("container_action_json", { deposit: 0, withdraw: 1 } as Record<string, number>).deposit ?? 0;
  const r = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN e.action=${DEP} THEN e.amount ELSE 0 END),0) dv,
            COALESCE(SUM(CASE WHEN e.action!=${DEP} THEN e.amount ELSE 0 END),0) wv
     FROM container_evt e WHERE e.phys_key=? AND e.rolled_back=0`
  ).get(key) as { dv: number; wv: number };
  return { dep_vol: r.dv, wdr_vol: r.wv };
}

/** Signature 1 : casse -> re-pose du conteneur par le même joueur + déficit de flux. */
function detectContainerDupe(placements: PlaceEvent[], insInc: ReturnType<typeof insertIncident>): number {
  const t = th();
  const w = wts();
  const win = t.dupe_window_sec ?? 600;
  const minCycles = t.dupe_min_cycles ?? 2;
  const minDeficit = t.dupe_min_deficit ?? 64;

  const destroyed = db.prepare(
    `SELECT COUNT(*) n FROM blk b
     WHERE b.wid=@wid AND b.x=@x AND b.y=@y AND b.z=@z AND b.uid=@uid
       AND b.action=1 AND b.rolled_back=0 AND b.type_id=@tid
       AND b.time < @time AND b.time >= @time - @win`
  );

  let created = 0;
  db.transaction(() => {
    for (const p of placements) {
      if ((fakeStmt.get(p.uid) as { is_fake: number } | undefined)?.is_fake ?? 1) continue;
      if ((whiteStmt.get(p.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) continue;

      const key = `${p.wid}|${p.x}|${p.y}|${p.z}`;
      const cycles = (destroyed.get({ wid: p.wid, x: p.x, y: p.y, z: p.z, uid: p.uid, tid: p.type_id, time: p.time, win }) as { n: number }).n;
      if (cycles < minCycles) continue;

      const flux = containerFlux(key);
      const deficit = flux.wdr_vol - flux.dep_vol;
      if (deficit < minDeficit) continue; // pose normale / coffre rempli : pas de sortie nette.

      const base = w.dupe_base ?? 45;
      const cyclePart = Math.min(w.dupe_cycle_max ?? 20, cycles * 5);
      const deficitPart = Math.min(w.dupe_amount_max ?? 25, (deficit / 64) * 10);
      const severity = Math.round((base + cyclePart + deficitPart) * 10) / 10;

      const evidence = {
        signature: "container_copy_replace",
        container_key: key,
        type_name: (nameOf.get(p.type_id, p.type_id) as { n: string }).n,
        cycles_replaced: cycles,
        window_sec: win,
        dep_vol: flux.dep_vol,
        wdr_vol: flux.wdr_vol,
        net_deficit: deficit,
        terms: { base, cycle_part: +cyclePart.toFixed(2), deficit_part: +deficitPart.toFixed(2) },
      };

      const vals = [
        "dupe", severity, p.uid, p.wid, p.x, p.y, p.z, null, key,
        p.type_id, deficit, p.time - win, p.time, JSON.stringify(evidence),
        "new", Math.floor(Date.now() / 1000), eventKey("blk", p.rowid),
      ];
      checkIncidentArgs(DUPE_COLS, vals);
      if (insInc.run(vals).changes > 0) created++;
    }
  })();

  return created;
}

/** Une fenêtre d'items au sol : ramassages contre les sources connues du joueur. */
function groundGroup(
  cur: ItemEvent[],
  acts: ItemAct,
  w: Wt,
  win: number,
  minSurplus: number,
  insInc: ReturnType<typeof insertIncident>,
): number {
  const dropVol = cur.filter((e) => acts.drop.includes(e.action)).reduce((s, e) => s + e.amount, 0);
  const pickVol = cur.filter((e) => acts.pickup.includes(e.action)).reduce((s, e) => s + e.amount, 0);
  const spawnVol = cur.filter((e) => acts.spawn.includes(e.action)).reduce((s, e) => s + e.amount, 0);

  const first = cur[0];
  const last = cur[cur.length - 1];
  // Les blocs cassés par le joueur autour de ses ramassages rendent des items : source légitime (1 item par bloc, proxy conservateur).
  const brokenNearby = (db.prepare(
    `SELECT COUNT(*) n FROM blk b
     WHERE b.uid=? AND b.wid=? AND abs(b.x-?)<=16 AND abs(b.z-?)<=64
       AND b.action=1 AND b.rolled_back=0 AND b.type_id=? AND b.time BETWEEN ? AND ?`
  ).get(first.uid, first.wid, last.x, last.z, first.type_id, first.time - 120, last.time + 120) as { n: number }).n;

  const surplus = pickVol + spawnVol - dropVol - brokenNearby;
  if (surplus < minSurplus) return 0;

  const base = w.dupe_base ?? 45;
  const surplusPart = Math.min(w.dupe_amount_max ?? 25, (surplus / 64) * 10);
  const severity = Math.round((base + surplusPart) * 10) / 10;

  const evidence = {
    signature: "ground_creation",
    item_name: (nameOf.get(first.type_id, first.type_id) as { n: string }).n,
    pickup_volume: pickVol,
    drop_volume: dropVol,
    spawn_volume: spawnVol,
    broken_blocks_nearby: brokenNearby,
    surplus,
    window_sec: win,
    actions_seen: [...new Set(cur.map((e) => e.action))],
    terms: { base, surplus_part: +surplusPart.toFixed(2) },
  };

  const vals = [
    "dupe", severity, first.uid, first.wid, first.x, first.y, first.z, null, null,
    first.type_id, surplus, first.time, last.time, JSON.stringify(evidence),
    "new", Math.floor(Date.now() / 1000), eventKey("item_evt", first.rowid),
  ];
  checkIncidentArgs(DUPE_COLS, vals);
  return insInc.run(vals).changes > 0 ? 1 : 0;
}

/** Signature 2 : ramassages d'un même item sans source comparable (fenêtre glissante par joueur+type). */
function detectGroundDupe(events: ItemEvent[], insInc: ReturnType<typeof insertIncident>): number {
  const t = th();
  const w = wts();
  const acts = itemActs();
  const win = t.ground_window_sec ?? 3600;
  const minSurplus = t.ground_surplus_min ?? 64;

  const byPair = new Map<string, ItemEvent[]>();
  for (const e of events) {
    if ((fakeStmt.get(e.uid) as { is_fake: number } | undefined)?.is_fake ?? 1) continue;
    if ((whiteStmt.get(e.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) continue;
    const k = `${e.uid}|${e.type_id}`;
    const arr = byPair.get(k) ?? [];
    arr.push(e);
    byPair.set(k, arr);
  }

  let created = 0;
  db.transaction(() => {
    for (const arr of byPair.values()) {
      arr.sort((a, b) => a.time - b.time || a.rowid - b.rowid);
      let cur: ItemEvent[] = [];
      for (const e of arr) {
        if (cur.length && e.time - cur[cur.length - 1].time > win) {
          created += groundGroup(cur, acts, w, win, minSurplus, insInc);
          cur = [e];
        } else cur.push(e);
      }
      if (cur.length) created += groundGroup(cur, acts, w, win, minSurplus, insInc);
    }
  })();

  return created;
}

/** Signature 3 : clones de chunk — re-création massive aux mêmes coordonnées dans un autre monde. */
function detectChunkClones(placements: PlaceEvent[], insInc: ReturnType<typeof insertIncident>): number {
  const t = th();
  const w = wts();
  const win = t.chunk_clone_window_sec ?? 900;
  const radius = t.clone_coord_radius ?? 8;
  const minBlocks = t.chunk_clone_min_blocks ?? 16;

  // Sources correspondantes dans les autres mondes (monde d'origine + nombre de blocs).
  const sources = db.prepare(
    `SELECT b.wid, COALESCE(w.name, CAST(b.wid AS TEXT)) name, COUNT(*) n FROM blk b
     LEFT JOIN world w ON w.wid=b.wid
     WHERE b.uid=@uid AND b.wid<>@wid AND abs(b.x-@x)<=@r AND abs(b.y-@y)<=8 AND abs(b.z-@z)<=@r
       AND b.action=0 AND b.rolled_back=0 AND b.time BETWEEN @time - @win AND @time
     GROUP BY b.wid`
  );

  let created = 0;
  db.transaction(() => {
    for (const p of placements) {
      if ((fakeStmt.get(p.uid) as { is_fake: number } | undefined)?.is_fake ?? 1) continue;
      if ((whiteStmt.get(p.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) continue;

      const src = sources.all({ uid: p.uid, wid: p.wid, x: p.x, y: p.y, z: p.z, r: radius, time: p.time, win }) as
        { wid: number; name: string; n: number }[];
      const total = src.reduce((s, r) => s + r.n, 0);
      if (total < minBlocks) continue;

      const base = w.dupe_base ?? 45;
      const blocksPart = Math.min(w.dupe_cycle_max ?? 20, (total / minBlocks) * 10);
      const severity = Math.round((base + blocksPart) * 10) / 10;

      const evidence = {
        signature: "chunk_clone",
        clone_blocks_in_place: 1,
        source_blocks: total,
        source_worlds: src.map((r) => ({ wid: r.wid, name: r.name, blocks: r.n })),
        dest_wid: p.wid,
        coords: { x: p.x, y: p.y, z: p.z },
        coord_radius: radius,
        window_sec: win,
        terms: { base, blocks_part: +blocksPart.toFixed(2) },
      };

      const vals = [
        "dupe", severity, p.uid, p.wid, p.x, p.y, p.z, null, null,
        p.type_id, total, p.time - win, p.time, JSON.stringify(evidence),
        "new", Math.floor(Date.now() / 1000), eventKey("blk", p.rowid),
      ];
      checkIncidentArgs(DUPE_COLS, vals);
      if (insInc.run(vals).changes > 0) created++;
    }
  })();

  return created;
}

/** Cycle de détection des dupes : curseurs sur blk et item_evt. */
export function detectDupes(blkFrom: number, itemFrom: number): { created: number; eventsScanned: number; skipped: Record<string, number> } {
  const acts = itemActs();

  const containerPlacements = db.prepare(
    `SELECT rowid,time,uid,wid,x,y,z,type_id FROM blk
     WHERE rowid > ? AND action=0 AND rolled_back=0 AND uid NOT NULL
       AND type_id IN (SELECT id FROM container_type)
     ORDER BY time, rowid`
  ).all(blkFrom) as PlaceEvent[];

  const allPlacements = db.prepare(
    `SELECT rowid,time,uid,wid,x,y,z,type_id FROM blk
     WHERE rowid > ? AND action=0 AND rolled_back=0 AND uid NOT NULL ORDER BY time, rowid`
  ).all(blkFrom) as PlaceEvent[];

  const itemEvents = db.prepare(
    `SELECT rowid,time,uid,wid,x,y,z,type_id,amount,action FROM item_evt
     WHERE rowid > ? AND rolled_back=0 AND uid NOT NULL ORDER BY time, rowid`
  ).all(itemFrom) as ItemEvent[];

  const kept = [...acts.drop, ...acts.pickup, ...acts.spawn];
  const skipped: Record<string, number> = { fake_user: 0, whitelisted: 0 };

  let created = detectContainerDupe(containerPlacements, insertIncident(DUPE_COLS));
  created += detectGroundDupe(itemEvents.filter((e) => kept.includes(e.action)), insertIncident(DUPE_COLS));
  created += detectChunkClones(allPlacements, insertIncident(DUPE_COLS));

  return { created, eventsScanned: containerPlacements.length + itemEvents.length + allPlacements.length, skipped };
}

/** Curseurs : un peu d'historique repris pour les fenêtres à cheval sur deux cycles. */
export function dupeScanCursors(): [number, number] {
  return [getCursor("dupe_blk_rowid", 3000), getCursor("dupe_item_rowid", 3000)];
}

export function setDupeScanCursors(blkRowid: number, itemRowid: number): void {
  setCursor("dupe_blk_rowid", blkRowid);
  setCursor("dupe_item_rowid", itemRowid);
}
