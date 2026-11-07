/** Pipeline d'analyse : recomputation lourde + cycle incrémental (tous les détecteurs). */
import { db } from "./db.js";
import { refreshTypeSets, rebuildChunkStatsAll, buildHomes, refreshChunkDelta } from "./analysis/houses.js";
import {
  refreshContainers,
  buildPhysContainers,
  assignEventsToPhys,
  rebuildAggregates,
  computeOwners,
  computeShares,
  dropEmptyOrphans,
} from "./analysis/ownership.js";
import { refreshItemRarity, detectTheft, theftScanCursor, setTheftScanCursor } from "./analysis/theft.js";
import { detectDupes, dupeScanCursors, setDupeScanCursors } from "./analysis/dupe.js";
import { detectGrief } from "./analysis/grief.js";
import { detectChurn, detectTnt } from "./analysis/anomaly.js";
import { detectChat, detectCommands } from "./analysis/chatwatch.js";
import { computeScores } from "./analysis/score.js";
import { getCursor, setCursor, maxRowid, ensureCursor } from "./analysis/cursor.js";

export interface CycleOutcome {
  chunksTouched: number;
  physContainersNew: number;
  eventsScanned: number;
  incidentsNew: number[]; // ids d'incidents créés ce cycle
  byKind: Record<string, number>;
}

/** Recomputation complète (premier lancement, et périodiquement). */
export function recomputeAll(): void {
  refreshTypeSets();
  rebuildChunkStatsAll();
  buildHomes();
  refreshItemRarity();
  refreshContainers();
}

/** Curseurs d'analyse initialisés : on ne rejoue pas tout l'historique au premier cycle. */
export function initCursors(): void {
  ensureCursor("grief_scan_rowid", maxRowid("blk"));
  ensureCursor("tnt_scan_rowid", maxRowid("blk"));
  ensureCursor("churn_scan_rowid", maxRowid("session_evt"));
  ensureCursor("chat_scan_rowid", maxRowid("chat_evt"));
  ensureCursor("cmd_scan_rowid", maxRowid("command_evt"));
  // Les détecteurs de duplication démarrent à la position courante d'ingestion.
  ensureCursor("dupe_blk_rowid", maxRowid("blk"));
  ensureCursor("dupe_item_rowid", maxRowid("item_evt"));
}

/** Ré-appariement complet des événements d'interaction sur les conteneurs physiques.
 *  On libère d'abord toutes les positions orphelines : un coffre posé ce cycle peut absorber
 *  des interactions anciennes (fermes enregistrées avant la pose du bloc, cf. co_container). */
export function remapEventsToContainers(sinceBlkRowid: number): number {
  const created = buildPhysContainers(sinceBlkRowid);
  db.prepare("UPDATE container_evt SET phys_key=NULL WHERE phys_key LIKE 'orph:%'").run();
  assignEventsToPhys(true);
  // Coût mesuré sur la base complète : < 0,2 s (quelques centaines de clés). Si le volume
  // d'événements conteneurs explose, on passera au recalcul des seules clés affectées.
  rebuildAggregates();
  computeOwners();
  // Copropriétaires et conteneurs partagés recalculés sur toutes les clés du cycle.
  computeShares();
  dropEmptyOrphans();
  return created;
}

/** Cycle incrémental : ingestion déjà faite, on rafraîchit ce qui a changé puis on détecte. */
export function cycleIncremental(sinceBlkRowid: number, sinceContRowid: number): CycleOutcome {
  const beforeInc = (db.prepare("SELECT COALESCE(MAX(id),0) m FROM incident").get() as { m: number }).m;

  const chunks = refreshChunkDelta(sinceBlkRowid); // coût = taille du lot inséré
  buildHomes();

  const created = remapEventsToContainers(sinceBlkRowid);

  const blkMax = maxRowid("blk");
  const contMax = maxRowid("container_evt");
  void sinceContRowid;

  const theft = detectTheft(theftScanCursor());
  setTheftScanCursor(contMax);

  const grief = detectGrief(getCursor("grief_scan_rowid", 2000));
  setCursor("grief_scan_rowid", blkMax);

  const tnt = detectTnt(getCursor("tnt_scan_rowid", 5000));
  setCursor("tnt_scan_rowid", blkMax);

  const churn = detectChurn(getCursor("churn_scan_rowid"));
  setCursor("churn_scan_rowid", maxRowid("session_evt"));

  const chat = detectChat(getCursor("chat_scan_rowid"));
  setCursor("chat_scan_rowid", maxRowid("chat_evt"));

  const cmds = detectCommands(getCursor("cmd_scan_rowid"));
  setCursor("cmd_scan_rowid", maxRowid("command_evt"));

  // Duplication : trois signatures sur blk / item_evt, curseurs dédiés.
  const [dupeBlkFrom, dupeItemFrom] = dupeScanCursors();
  const dupes = detectDupes(dupeBlkFrom, dupeItemFrom);
  setDupeScanCursors(blkMax, maxRowid("item_evt"));

  computeScores();

  const newIds = (db.prepare("SELECT id,kind FROM incident WHERE id > ? ORDER BY id").all(beforeInc) as { id: number; kind: string }[]);
  const byKind: Record<string, number> = {};
  for (const r of newIds) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  return {
    chunksTouched: chunks.size,
    physContainersNew: created,
    eventsScanned: theft.eventsScanned + grief.eventsScanned + tnt.eventsScanned + churn.eventsScanned + chat.eventsScanned + cmds.eventsScanned + dupes.eventsScanned,
    incidentsNew: newIds.map((r) => r.id),
    byKind,
  };
}
