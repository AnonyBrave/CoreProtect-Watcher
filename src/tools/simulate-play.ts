/**
 * Validation du scoring sur des cas de jeu simulés (P2).
 * Les lignes injectées sont marquées test=1 et effacées après la détection ; les incidents
 * produits restent marqués test=1 pour ne jamais polluer le flux d'alertes réel.
 */
import { db } from "../db.js";
import { buildHomes, refreshChunkStats, homeOfPoint } from "../analysis/houses.js";
import { maxRowid, setCursor } from "../analysis/cursor.js";
import { refreshItemRarity } from "../analysis/theft.js";
import { cycleIncremental } from "../pipeline.js";

function ensureTestColumn(table: string): void {
  const info = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!info.some((i) => i.name === "test")) db.exec(`ALTER TABLE ${table} ADD COLUMN test INTEGER NOT NULL DEFAULT 0`);
}

/** Zones de simulation (loin du territoire réel, sans lignes de bloc). */
const AREAS = [
  { wid: 1, x: 3000, z: -4200 },
  { wid: 1, x: 3500, z: -4600 },
  { wid: 1, x: -3000, z: 3200 },
];

function findEmptyArea(): { wid: number; x: number; z: number } {
  for (const c of AREAS) {
    const n = (db.prepare("SELECT COUNT(*) n FROM blk WHERE wid=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?")
      .get(c.wid, c.x - 64, c.x + 64, c.z - 64, c.z + 64) as { n: number }).n;
    if (n === 0) return c;
  }
  return AREAS[0];
}

/** Boîte englobant une zone de simulation (maison + coffre + coffre sauvage). */
function boxOf(a: { wid: number; x: number; z: number }) {
  return { wid: a.wid, x0: a.x - 100, x1: a.x + 600, z0: a.z - 700, z1: a.z + 100 };
}

/** Nettoyage complet de l'état issu des simulations : lignes marquées test=1, conteneurs
 *  physiques / usage / propriété dans les zones simulées, et stats de chunk correspondantes. */
function cleanSim(): void {
  const boxes = AREAS.map(boxOf);
  db.prepare("DELETE FROM blk WHERE test=1").run();
  db.prepare("DELETE FROM container_evt WHERE test=1").run();
  db.prepare("DELETE FROM session_evt WHERE test=1").run();

  const delUse = db.prepare("DELETE FROM usage_stat WHERE key=?");
  const delOwner = db.prepare("DELETE FROM container_owner WHERE key=?");
  const delPhys = db.prepare("DELETE FROM phys_container WHERE key=?");
  const selKeys = db.prepare(
    "SELECT key FROM phys_container WHERE wid=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?"
  );

  const simChunks = new Set<string>();
  db.transaction(() => {
    for (const b of boxes) {
      for (const r of selKeys.all(b.wid, b.x0, b.x1, b.z0, b.z1) as { key: string }[]) {
        delUse.run(r.key);
        delOwner.run(r.key);
        delPhys.run(r.key);
      }
      // Les chunks de la boîte sont recalculés après suppression des lignes injectées.
      for (let cx = b.x0 >> 4; cx <= b.x1 >> 4; cx++) {
        for (let cz = b.z0 >> 4; cz <= b.z1 >> 4; cz++) simChunks.add(`${b.wid}:${cx}:${cz}`);
      }
    }
  })();

  refreshChunkStats(simChunks);
  buildHomes();

  // Les curseurs d'analyse ne doivent pas rester au-dessus des rowids réels (les lignes de simulation
  // ont des rowids gonflés : un curseur trop haut ferait sauter les lots suivants).
  setCursor("grief_scan_rowid", maxRowid("blk"));
  setCursor("tnt_scan_rowid", maxRowid("blk"));
  setCursor("theft_scan_rowid", maxRowid("container_evt"));
  setCursor("churn_scan_rowid", maxRowid("session_evt"));
  setCursor("chat_scan_rowid", maxRowid("chat_evt"));
  setCursor("cmd_scan_rowid", maxRowid("command_evt"));
}

const DEP = 0, WDR = 1; // action conteneur : dépôt / retrait

function main() {
  ensureTestColumn("incident");
  ensureTestColumn("session_evt");
  cleanSim(); // purge l'état des exécutions précédentes
  refreshItemRarity(); // paliers de rareté pour le bonus de sévérité
  const y = 70;
  const area = findEmptyArea();
  const t0 = Math.floor(Date.now() / 1000);
  const now = t0 + 3600; // horizon de temps simulé (loin au-delà des données réelles)

  const blkBase = maxRowid("blk") + 10000;
  const contBase = maxRowid("container_evt") + 10000;
  const sessBase = maxRowid("session_evt") + 10000;

  // Aides d'insertion.
  const insBlk = db.prepare(
    "INSERT INTO blk(rowid,time,uid,wid,x,y,z,type_id,bdata,action,rolled_back,test) VALUES(@rowid,@time,@uid,@wid,@x,@y,@z,@type_id,@bdata,@action,0,1)"
  );
  const insCont = db.prepare(
    "INSERT INTO container_evt(rowid,time,uid,wid,x,y,z,item_id,amount,action,rolled_back,meta,test) VALUES(@rowid,@time,@uid,@wid,@x,@y,@z,@item_id,@amount,@action,0,'',1)"
  );
  const insSess = db.prepare(
    "INSERT INTO session_evt(rowid,time,uid,wid,x,y,z,action,test) VALUES(@rowid,@time,@uid,@wid,@x,@y,@z,@action,1)"
  );

  const idsOf = (name: string): number => {
    const r = db.prepare("SELECT id FROM material WHERE name=?").get(name) as { id: number } | undefined;
    if (!r) throw new Error(`matériau inconnu: ${name}`);
    return r.id;
  };

  let blkSeq = blkBase;
  const placeBlock = (uid: number, x: number, yy: number, z: number, matName: string, time: number) => {
    insBlk.run({ rowid: ++blkSeq, time, uid, wid: area.wid, x, y: yy, z, type_id: idsOf(matName), bdata: 0, action: 0 });
  };

  const cassBlock = (uid: number, x: number, yy: number, z: number, matName: string, time: number) => {
    insBlk.run({ rowid: ++blkSeq, time, uid, wid: area.wid, x, y: yy, z, type_id: idsOf(matName), bdata: 0, action: 1 });
  };

  let sessSeq = sessBase;
  const login = (uid: number, x: number, z: number, time: number) => {
    insSess.run({ rowid: ++sessSeq, time, uid, wid: area.wid, x, y: y, z, action: 0 });
  };

  let contSeq = contBase;
  const contEvent = (uid: number, x: number, yy: number, z: number, itemName: string, amount: number, time: number, action: number) => {
    insCont.run({ rowid: ++contSeq, time, uid, wid: area.wid, x, y: yy, z, item_id: idsOf(itemName), amount, action });
  };

  // --- Cas 1 : AnonyBroke (uid 14) construit une petite maison + coffre -> il devient owner.
  const hx = area.x, hz = area.z;
  login(14, hx, hz, now - 900);
  for (let i = 0; i < 60; i++) {
    placeBlock(14, hx + (i % 5) - 2, y, hz + Math.floor(i / 5) - 2, "minecraft:cobblestone", now - 800 + i);
  }
  placeBlock(14, hx, y, hz, "minecraft:oak_door", now - 700);
  placeBlock(14, hx + 1, y, hz + 1, "minecraft:torch", now - 690);
  placeBlock(14, hx + 2, y, hz + 2, "minecraft:furnace", now - 685);
  const chestX = hx, chestZ = hz + 3;
  placeBlock(14, chestX, y, chestZ, "minecraft:chest", now - 600);

  // Il dépose des objets (dépôts, action 0).
  for (let i = 0; i < 3; i++) contEvent(14, chestX + 1, y + 1, chestZ, "minecraft:diamond", 5, now - 500 + i * 20, DEP);

  // --- Cas 2 : Xelrez (uid 40) retire des objets du coffre d'AnonyBroke -> alerte attendue.
  login(40, chestX, hz, now - 100);
  contEvent(40, chestX + 1, y + 1, chestZ, "minecraft:diamond", 5, now - 60, WDR);
  contEvent(40, chestX + 1, y + 1, chestZ, "minecraft:gold_ingot", 32, now - 45, WDR);

  // --- Cas 3 : AnonyBrave (whitelist) retire le même coffre -> aucune alerte.
  login(1, chestX, hz, now - 40);
  contEvent(1, chestX + 1, y + 1, chestZ, "minecraft:diamond", 5, now - 20, WDR);

  // --- Cas 4 : coffre posé en pleine nature par un faux utilisateur -> non attribué, silencieux.
  const wild = { x: area.x + 400, z: area.z - 380 };
  const fake = (db.prepare("SELECT uid FROM player WHERE is_fake=1 LIMIT 1").get() as { uid: number }).uid;
  placeBlock(fake, wild.x, y, wild.z, "minecraft:chest", now - 500);
  login(40, wild.x, wild.z, now - 30);
  contEvent(40, wild.x + 1, y + 1, wild.z, "minecraft:dirt", 64, now - 25, DEP);
  contEvent(40, wild.x + 1, y + 1, wild.z, "minecraft:dirt", 32, now - 15, WDR);

  // --- Cas 5 : Xelrez casse 12 blocs de la maison d'AnonyBroke -> grief attendu.
  for (let i = 0; i < 12; i++) {
    cassBlock(40, hx + (i % 5) - 2, y, hz + Math.floor(i / 5) - 2, "minecraft:cobblestone", now - 90 + i);
  }

  // --- Cas 6 : Xelrez pose 5 TNT dans la zone d'AnonyBroke -> anomalie attendue.
  for (let i = 0; i < 5; i++) {
    placeBlock(40, hx + i - 2, y, hz - 1, "minecraft:tnt", now - 70 + i);
  }

  // --- Cas 7 : AnonyBrave (whitelist) casse et pose dans la zone d'autrui -> aucune alerte.
  for (let i = 0; i < 12; i++) {
    cassBlock(1, hx + (i % 5) - 2, y, hz + Math.floor(i / 5) - 6, "minecraft:cobblestone", now - 40 + i);
    placeBlock(1, hx + (i % 5) - 2, y, hz + Math.floor(i / 5) - 9, "minecraft:stone", now - 30 + i);
    placeBlock(1, hx + (i % 5) - 2, y, hz - 2, "minecraft:tnt", now - 20 + i);
  }

  // Analyse incrémentale sur tout ce qui a été injecté.
  const dirtyChunks = new Set<string>();
  for (const cx of [hx >> 4, chestX >> 4, wild.x >> 4]) {
    dirtyChunks.add(`${area.wid}:${cx}:${hz >> 4}`);
    dirtyChunks.add(`${area.wid}:${cx}:${(hz + 3) >> 4}`);
    dirtyChunks.add(`${area.wid}:${wild.x >> 4}:${wild.z >> 4}`);
  }

  const idsBefore = new Set((db.prepare("SELECT id FROM incident").all() as { id: number }[]).map((r) => r.id));

  // On repart d'un scan propre pour la détection.
  db.prepare("INSERT INTO analysis_state(key,value) VALUES('theft_scan_rowid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(contBase - 1));
  const outcome = cycleIncremental(blkBase - 1, contBase - 1);

  // Marquage test des incidents produits par la simulation.
  const newIds = (db.prepare("SELECT id FROM incident ORDER BY id").all() as { id: number }[])
    .map((r) => r.id)
    .filter((id) => !idsBefore.has(id));
  const mark = db.prepare("UPDATE incident SET test=1 WHERE id=?");
  db.transaction(() => { for (const id of newIds) mark.run(id); })();

  console.log(`zones: maison(${hx},${hz}) coffre(${chestX},${chestZ}) wild(${wild.x},${wild.z})`);
  console.log("chunks touchés:", outcome.chunksTouched, "événements scannés:", outcome.eventsScanned);

  console.log("\n=== Incidents produits ===");
  for (const r of db.prepare(
    `SELECT i.id,i.kind,i.severity,i.uid,p.name,i.victim_uid,v.name victim,i.x,i.z,i.amount,i.container_key
     FROM incident i JOIN player p ON p.uid=i.uid LEFT JOIN player v ON v.uid=i.victim_uid
     WHERE i.test=1 ORDER BY i.severity DESC`
  ).all()) console.log(JSON.stringify(r));

  console.log("\n=== chunk_stat de la zone simulée (après cycle) ===");
  const probeCx = area.x >> 4;
  const probeCz = area.z >> 4;
  for (const r of db.prepare(
    `SELECT cs.cx,cs.cz,cs.uid,p.name,cs.placed,cs.broken,cs.functional,cs.types
     FROM chunk_stat cs JOIN player p ON p.uid=cs.uid
     WHERE cs.wid=? AND cs.cx BETWEEN ? AND ? AND cs.cz BETWEEN ? AND ? ORDER BY cs.uid, cs.cx, cs.cz`
  ).all(area.wid, probeCx - 2, probeCx + 25, probeCz - 12, probeCz + 4)) console.log(JSON.stringify(r));

  console.log("\n=== Clusters de la zone simulée (après cycle) ===");
  for (const r of db.prepare(
    `SELECT h.id,h.uid,p.name,h.kind,cx0*16 xmin,cx1*16+15 xmax,cz0*16 zmin,cz1*16+15 zmax,
            blocks_placed,functional_count,distinct_types
     FROM home_cluster h JOIN player p ON p.uid=h.uid
     WHERE h.wid=? AND cx1*16 >= ? AND cx0*16 <= ? AND cz1*16 >= ? AND cz0*16 <= ?`
  ).all(area.wid, hx - 200, hx + 700, hz - 800, hz + 200)) console.log(JSON.stringify(r));

  const probePoint = homeOfPoint(area.wid, hx, hz);
  console.log(`homeOfPoint(${hx},${hz}) =`, JSON.stringify(probePoint));
  for (const r of db.prepare(
    `SELECT c.key,c.x,c.y,c.z,c.placed_uid,o.owner_uid,p.name owner,o.score,o.trust_state
     FROM phys_container c JOIN container_owner o ON o.key=c.key LEFT JOIN player p ON p.uid=o.owner_uid
     WHERE c.orphan=1 OR abs(c.x - ?) <= 300 ORDER BY c.key LIMIT 25`
  ).all(hx)) console.log(JSON.stringify(r));

  // Critères de la recette de validation P2.
  const houseKey = `1|${chestX}|${y}|${chestZ}`;
  const wildKey = `1|${wild.x}|${y}|${wild.z}`;

  const own = db.prepare(
    "SELECT owner_uid,trust_state,locked,score FROM container_owner WHERE key=?"
  ).get(houseKey) as { owner_uid: number; trust_state: string; locked: number; score: number } | undefined;

  const theftByXelrez = db.prepare("SELECT COUNT(*) n FROM incident WHERE test=1 AND kind='theft' AND uid=40").get() as { n: number };
  const sevMax = (db.prepare("SELECT MAX(severity) s FROM incident WHERE test=1 AND kind='theft' AND uid=40").get() as { s: number | null }).s;
  const theftByAdmin = db.prepare("SELECT COUNT(*) n FROM incident WHERE test=1 AND kind='theft' AND uid=1").get() as { n: number };

  const wildState = db.prepare("SELECT trust_state,owner_uid,score FROM container_owner WHERE key=?").get(wildKey) as
    | { trust_state: string; owner_uid: number; score: number }
    | undefined;
  const wildIncidents = (db.prepare("SELECT COUNT(*) n FROM incident WHERE test=1 AND container_key=?").get(wildKey) as { n: number }).n;

  console.log("\n=== Critères ===");
  console.log(
    `1. AnonyBroke pose sa maison + son coffre -> owner=${own?.owner_uid} (${own?.trust_state}, score ${own?.score}) : ${own && own.owner_uid === 14 ? "PASS" : "FAIL"}`
  );
  console.log(
    `2. Xelrez retire le coffre d'AnonyBroke -> ${theftByXelrez.n} alerte(s), sévérité max ${sevMax} : ${theftByXelrez.n >= 1 && (sevMax ?? 0) >= 60 ? "PASS" : "FAIL"}`
  );
  console.log(`3. AnonyBrave exempté -> ${theftByAdmin.n} alerte : ${theftByAdmin.n === 0 ? "PASS" : "FAIL"}`);
  console.log(
    `4. Coffre posé par un faux utilisateur en pleine nature -> état ${wildState?.trust_state}, score ${wildState?.score}, ${wildIncidents} alerte(s) : ${wildIncidents === 0 && (wildState?.trust_state === "ambiguous" || wildState?.trust_state === "untracked") ? "PASS" : "FAIL"}`
  );

  const griefXelrez = db.prepare(
    "SELECT COUNT(*) n, COALESCE(MAX(severity),0) s FROM incident WHERE test=1 AND kind='grief' AND uid=40 AND victim_uid=14"
  ).get() as { n: number; s: number };
  const tntXelrez = db.prepare(
    `SELECT COUNT(*) n, COALESCE(MAX(severity),0) s, COALESCE(MAX(json_extract(evidence_json,'$.tnt_count')),0) t
     FROM incident WHERE test=1 AND kind='anomaly' AND uid=40 AND victim_uid=14`
  ).get() as { n: number; s: number; t: number };
  const adminAlerts = (db.prepare(
    "SELECT COUNT(*) n FROM incident WHERE test=1 AND uid=1"
  ).get() as { n: number }).n;

  console.log(
    `5. Xelrez casse 12 blocs de la maison d'AnonyBroke -> ${griefXelrez.n} alerte(s), sévérité max ${griefXelrez.s} : ${griefXelrez.n >= 1 && griefXelrez.s >= 60 ? "PASS" : "FAIL"}`
  );
  console.log(
    `6. Xelrez pose 5 TNT dans la zone d'AnonyBroke -> ${tntXelrez.n} alerte(s), tnt compté ${tntXelrez.t}, sévérité max ${tntXelrez.s} : ${tntXelrez.n >= 1 && tntXelrez.t >= 4 && tntXelrez.s >= 50 ? "PASS" : "FAIL"}`
  );
  console.log(`7. AnonyBrave exempté (casse + pose + TNT en zone d'autrui) -> ${adminAlerts} alerte : ${adminAlerts === 0 ? "PASS" : "FAIL"}`);

  // Nettoyage : lignes injectées (test=1) et état dérivé de la simulation disparaissent.
  // Les incidents marqués test=1 restent pour la revue (exclus des flux réels par le drapeau).
  const injected = { blk: blkSeq - blkBase + 1, cont: contSeq - contBase + 1, sess: sessSeq - sessBase + 1 };
  cleanSim();

  console.log(`lignes injectées retirées: blk=${injected.blk} cont=${injected.cont} sessions=${injected.sess}`);
}

main();
