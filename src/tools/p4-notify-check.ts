/** Validation P4 : envoie l'incident réel le plus sévère par le chemin de production notifyIncident. */
import { db } from "../db.js";
import { notifyIncident } from "../notify.js";

interface Row {
  id: number;
  kind: string;
  severity: number;
  uid: number | null;
  victim_uid: number | null;
  name: string | null;
  victim_name: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  container_key: string | null;
  amount: number | null;
  window_start: number | null;
  window_end: number | null;
}

const row = db.prepare(
  `SELECT i.id,i.kind,i.severity,i.uid,i.victim_uid,p.name,v.name victim_name,
          i.x,i.y,i.z,i.container_key,i.amount,i.window_start,i.window_end
   FROM incident i LEFT JOIN player p ON p.uid=i.uid LEFT JOIN player v ON v.uid=i.victim_uid
   WHERE i.test=0 ORDER BY severity DESC LIMIT 1`
).get() as Row | undefined;

if (!row) {
  console.log("[p4] aucun incident réel en base");
  process.exit(1);
}

console.log(`[p4 incident retenu] ${JSON.stringify(row)}`);
await notifyIncident(row);
console.log("[notify_log dernier]", db.prepare("SELECT * FROM notify_log ORDER BY created_at DESC LIMIT 3").all());
