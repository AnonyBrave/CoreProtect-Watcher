/** Test de l'import des dumps mysqldump + des détecteurs dupe / copropriétaires sur données synthétiques.
 *  Lancez avec une base isolée : $env:CP_SQLITE_FILE="data\test-import.db" puis npx tsx tools/import-test.ts */
import fs from "node:fs";
import path from "node:path";
import { db, getSetting, setSetting } from "../src/db.js";
import { importPending, importDir } from "../src/sqlimport.js";
import { refreshContainers } from "../src/analysis/ownership.js";
import { refreshTypeSets } from "../src/analysis/houses.js";
import { detectTheft } from "../src/analysis/theft.js";
import { detectDupes } from "../src/analysis/dupe.js";

const FIX_DIR = path.resolve("data", "test-imports");
fs.rmSync(FIX_DIR, { recursive: true, force: true });
fs.mkdirSync(FIX_DIR, { recursive: true });
setSetting("import_json", { dir: FIX_DIR });

/** Le blob metadata Java (paires de jetons 0x74 0x00 len texte) encode {"meta":"990"}. */
function javaBlob(pairs: [string, string][]): Buffer {
  const parts: number[] = [];
  for (const [k, v] of pairs) {
    for (const s of [k, v]) {
      parts.push(0x74, 0x00);
      parts.push((s.length >> 8) & 255, s.length & 255);
      for (const ch of s) parts.push(ch.charCodeAt(0));
    }
  }
  return Buffer.from(parts);
}

function hexX(b: Buffer): string {
  return `X'${b.toString("hex")}'`;
}

const T = 1700000000; // horloge de départ des fixtures

// Fichier a : joueurs, mondes, materiaux, conteneurs (colonnes explicites), blocs.
const fileA = [
  "-- MySQL dump 10.13  Distrib 8.0.36, for Win64",
  "/*!40101 SET @saved_cs_client     = @@character_set_client */;",
  "",
  "DROP TABLE IF EXISTS `co_user`;",
  "CREATE TABLE `co_user` (",
  "  `rowid` bigint(20) NOT NULL AUTO_INCREMENT,",
  "  `time` bigint(20) NOT NULL,",
  "  `user` varchar(40) NOT NULL,",
  "  `uuid` varchar(36) DEFAULT NULL,",
  "  PRIMARY KEY (`rowid`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8;",
  "INSERT INTO `co_user` VALUES (501," + T + ",'OwnerOne','b9c2c6a8-1111-4bbb-8888-abcdef012345');",
  "INSERT INTO `co_user` VALUES (502," + T + ",'CoOwnerB','c9c2c6a8-2222-4bbb-8888-abcdef012345');",
  "",
  "CREATE TABLE `co_world` (",
  "  `id` bigint(20) NOT NULL,",
  "  `name` varchar(40) NOT NULL,",
  "  PRIMARY KEY (`id`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8;",
  "INSERT INTO `co_world` VALUES (9,'duptest'),(10,'clone_src');",
  "",
  "CREATE TABLE `co_material_map` (",
  "  `id` bigint(20) NOT NULL,",
  "  `value` varchar(64) DEFAULT NULL,",
  "  PRIMARY KEY (`id`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8;",
  "INSERT INTO `co_material_map` VALUES (68,'minecraft:chest'),(64,'minecraft:cobblestone');",
  "",
  "CREATE TABLE `co_block` (",
  "  `rowid` bigint(20) NOT NULL AUTO_INCREMENT,",
  "  `time` bigint(20) NOT NULL,",
  "  `user` varchar(40) DEFAULT NULL,",
  "  `wid` int(11) NOT NULL,",
  "  `x` int(15) NOT NULL,",
  "  `y` int(15) NOT NULL,",
  "  `z` int(15) NOT NULL,",
  "  `type` varchar(64) DEFAULT NULL,",
  "  `data` blob,",
  "  `action` tinyint(3) NOT NULL,",
  "  `rolled_back` tinyint(1) NOT NULL,",
  "  PRIMARY KEY (`rowid`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8;",
];

// Chest posé par OwnerOne à (9 | 40,64,300), deux casses puis une re-pose : cycles de copie.
const chest = (time: number, action: number): string =>
  `INSERT INTO \`co_block\` (time,user,wid,x,y,z,type,data,action,rolled_back) VALUES (${time},'OwnerOne',9,40,64,300,68,NULL,${action},0);`;

// Clones de chunk : 20 poses identiques dans clone_src (wid 10), puis re-création dans duptest (wid 9).
const cloneRows: string[] = [];
for (let i = 0; i < 20; i++) {
  const x = 100 + (i % 4);
  const z = -50 + Math.floor(i / 4);
  const y = 70;
  cloneRows.push(`INSERT INTO \`co_block\` (time,user,wid,x,y,z,type,data,action,rolled_back) VALUES (${T + i},'OwnerOne',10,${x},${y},${z},68,NULL,0,0);`);
}
const cloneDest: string[] = [];
for (let i = 0; i < 20; i++) {
  const x = 100 + (i % 4);
  const z = -50 + Math.floor(i / 4);
  const y = 70;
  cloneDest.push(`INSERT INTO \`co_block\` (time,user,wid,x,y,z,type,data,action,rolled_back) VALUES (${T + 300 + i},'OwnerOne',9,${x},${y},${z},68,NULL,0,0);`);
}

// Conteneurs : OwnerOne dépose 4 lots (128), CoOwnerB dépose 96 et retire 300 (ratio > seuil).
const metaBlob = hexX(javaBlob([["meta", "990"]]));
const cont: string[] = [];
const cDepA: number[] = [T + 40, T + 50, T + 60, T + 70];
for (let i = 0; i < 4; i++) {
  cont.push(`INSERT INTO \`co_container\` (time,user,wid,x,y,z,type,amount,action,rolled_back,metadata) VALUES (${cDepA[i]},'OwnerOne',9,40,64,300,64,${32},0,0,${metaBlob});`);
}
for (let i = 0; i < 3; i++) {
  cont.push(`INSERT INTO \`co_container\` (time,user,wid,x,y,z,type,amount,action,rolled_back,metadata) VALUES (${T + 80 + i},'CoOwnerB',9,40,64,300,64,${32},0,0,NULL);`);
}
for (let i = 0; i < 5; i++) {
  cont.push(`INSERT INTO \`co_container\` (time,user,wid,x,y,z,type,amount,action,rolled_back,metadata) VALUES (${T + 90 + i},'CoOwnerB',9,40,64,300,64,${60},1,0,NULL);`);
}

const fileA_content =
  fileA.join("\n") + "\n" + [chest(T, 0), chest(T + 10, 1), chest(T + 25, 1), chest(T + 45, 0)].join("\n") + "\n" + cloneRows.join("\n") + "\n" + cloneDest.join("\n") + "\n" + cont.join("\n") + "\n";

// Fichier b : co_item en valeurs positionnelles (ordre des colonnes du CREATE TABLE).
const fileB = [
  "CREATE TABLE `co_item` (",
  "  `rowid` bigint(20) NOT NULL AUTO_INCREMENT,",
  "  `time` bigint(20) NOT NULL,",
  "  `user` varchar(40) DEFAULT NULL,",
  "  `wid` int(11) NOT NULL,",
  "  `x` int(15) NOT NULL,",
  "  `y` int(15) NOT NULL,",
  "  `z` int(15) NOT NULL,",
  "  `type` varchar(64) DEFAULT NULL,",
  "  `amount` int(11) NOT NULL,",
  "  `action` tinyint(3) NOT NULL,",
  "  `rolled_back` tinyint(1) NOT NULL,",
  "  PRIMARY KEY (`rowid`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8;",
  // Un drop, quatre ramassages massifs (ramassages >> source = création sans origine).
  "INSERT INTO `co_item` VALUES (7001," + (T + 200) + ",'CoOwnerB',9,500,64,300,64,8,0,0);",
  "INSERT INTO `co_item` VALUES (7002," + (T + 210) + ",'CoOwnerB',9,500,64,300,64,64,1,0);",
  "INSERT INTO `co_item` VALUES (7003," + (T + 220) + ",'CoOwnerB',9,502,64,301,64,64,1,0);",
  "INSERT INTO `co_item` VALUES (7004," + (T + 230) + ",'CoOwnerB',9,504,64,302,64,64,2,0);",
];

// Fichier c : une ligne de conteneur identique à celle du fichier a -> doit être dédupliquée.
const dupLine = `INSERT INTO \`co_container\` (time,user,wid,x,y,z,type,amount,action,rolled_back,metadata) VALUES (${T + 40},'OwnerOne',9,40,64,300,64,${32},0,0,${metaBlob});`;

fs.writeFileSync(path.join(FIX_DIR, "a.sql"), fileA_content);
fs.writeFileSync(path.join(FIX_DIR, "b.sql"), fileB.join("\n") + "\n");

const count = (t: string): number => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[test] ÉCHEC : ${msg}`);
    process.exit(1);
  }
}

const before = { blk: count("blk"), cont: count("container_evt"), item: count("item_evt"), player: count("player") };
const resA = importPending((s) => console.log(s));

assert(count("blk") - before.blk === 4 + 20 + 20, `blocs importés (${count("blk") - before.blk})`);
assert(count("container_evt") - before.cont === 12, `conteneurs importés (${count("container_evt") - before.cont})`);
assert(count("item_evt") - before.item === 4, `items importés (${count("item_evt") - before.item})`);
assert(count("player") - before.player >= 2, `joueurs importés (${count("player") - before.player})`);

// Métadonnées Java -> JSON lisible dans le cache.
const metaRow = db.prepare("SELECT meta FROM container_evt WHERE uid=501 AND amount=32").get() as { meta: string } | undefined;
assert(!!metaRow && JSON.parse(metaRow.meta).meta === "990", `metadata décodée (${metaRow?.meta})`);

// Ledger : les deux fichiers marqués, une re-lecture n'ajoute rien.
const ledger = getSetting<Record<string, number>>("import_files_json", {} as Record<string, number>);
assert(ledger["a.sql"] > 0 && ledger["b.sql"] === 4, `ledger ${JSON.stringify(ledger)}`);

fs.writeFileSync(path.join(FIX_DIR, "c.sql"), dupLine + "\n");
const afterB = { blk: count("blk"), cont: count("container_evt"), item: count("item_evt") };
importPending((s) => console.log(s));
assert(count("blk") === afterB.blk && count("container_evt") === afterB.cont, "déduplication de la ligne dupliquée (c.sql)");

// Analyse complète sur les fixtures : types, agrégats, copropriétaires, vol entre copropriétaires, dupes.
refreshTypeSets();
const containers = refreshContainers();
console.log(`[test] conteneurs physiques construits : ${containers}`);

const shares = db.prepare("SELECT uid,score,share,co_owner FROM container_share WHERE key='9|40|64|300' ORDER BY uid").all() as { uid: number; score: number; share: number; co_owner: number }[];
assert(shares.length >= 2 && shares.some((s) => s.co_owner === 1), `copropriétaires (${JSON.stringify(shares)})`);

const owner = db.prepare("SELECT owner_uid,trust_state FROM container_owner WHERE key='9|40|64|300'").get() as { owner_uid: number; trust_state: string } | undefined;
assert(!!owner && owner.trust_state === "shared" && owner.owner_uid === 501, `propriétaire et état partagé (${JSON.stringify(owner)})`);

const theft = detectTheft(0);
assert(theft.created >= 1, `vol entre copropriétaires détecté (${theft.created})`);

const dupes = detectDupes(0, 0);
const kinds = db.prepare("SELECT kind, COUNT(*) n FROM incident WHERE test=0 GROUP BY kind").all() as { kind: string; n: number }[];
console.log(`[test] incidents par nature : ${JSON.stringify(kinds)}`);

for (const sig of ["container_copy_replace", "ground_creation", "chunk_clone"]) {
  const hit = db.prepare("SELECT COUNT(*) c FROM incident WHERE test=0 AND json_extract(evidence_json,'$.signature')=?").get(sig) as { c: number };
  assert(hit.c >= 1, `signature de dupe ${sig} (${hit.c})`);
}

const sharedIncident = db.prepare("SELECT severity,victim_uid,evidence_json FROM incident WHERE kind='theft_shared' AND test=0 ORDER BY id LIMIT 1").get() as { severity: number; victim_uid: number } | undefined;
assert(!!sharedIncident && sharedIncident.victim_uid === 501, `incident theft_shared avec le propriétaire en victime (${JSON.stringify(sharedIncident)})`);

console.log(`[test] OK : ${containers} conteneurs, ${theft.created} vols, ${dupes.created} dupes.`);
