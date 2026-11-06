/** Notifications : flux SSE interne + webhook Discord filtré par sévérité. */
import { db, getSetting } from "./db.js";
import { cfg } from "./config.js";

type RawRes = {
  write: (s: string) => void;
  end: () => void;
  on: (ev: string, cb: () => void) => void;
};

const clients = new Set<RawRes>();

export function addSseClient(res: RawRes): void {
  clients.add(res);
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
}

export function removeSseClient(res: RawRes): void {
  clients.delete(res);
}

export function sseCount(): number {
  return clients.size;
}

/** Diffuse un événement à tous les clients connectés. */
export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata:${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

interface IncidentRow {
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

const KIND_LABEL: Record<string, string> = { theft: "Vol", grief: "Grief", anomaly: "Anomalie", chat: "Propos" };

function formatDiscordMessage(i: IncidentRow): string {
  const loc = i.x !== null ? `x=${i.x} y=${i.y} z=${i.z}` : "?";
  const lines = [
    `**${KIND_LABEL[i.kind] ?? i.kind}** — sévérité **${i.severity}**`,
    `Acteur : ${i.name ?? "?"}`,
    i.victim_name ? `Propriétaire lésé : ${i.victim_name}` : "",
    i.container_key ? `Conteneur : \`${i.container_key}\` (retrait de ${i.amount ?? 0} objets)` : "",
    `Position : ${loc}`,
    `Fenêtre : ${new Date((i.window_start ?? 0) * 1000).toLocaleString("fr-FR")} → ${new Date((i.window_end ?? 0) * 1000).toLocaleString("fr-FR")}`,
    "Détails dans CoreProtect-Watcher :",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Appelle le webhook Discord si la sévérité atteint le seuil configuré (réglages UI, sinon .env). */
export async function notifyIncident(i: IncidentRow): Promise<void> {
  const th = getSetting("thresholds_json", {} as Record<string, number>);
  const d = getSetting<Record<string, unknown>>("discord_json", {}) as { url?: string; min_severity?: number; username?: string };
  const url = d.url?.trim() || cfg.discordWebhook;
  const minSev = d.min_severity ?? th.discord_min_severity ?? th.theft_alert_severity ?? 60;
  if (!url || i.severity < minSev) return;

  const logIns = db.prepare(
    "INSERT INTO notify_log(incident_id,channel,status,detail,created_at) VALUES(?,?,?,?,?)"
  );
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: d.username ?? "coreprotect-watcher", content: formatDiscordMessage(i) }),
    });
    logIns.run(i.id, "discord", r.ok ? "ok" : `http ${r.status}`, r.ok ? null : (await r.text()).slice(0, 200), Math.floor(Date.now() / 1000));
  } catch (e) {
    logIns.run(i.id, "discord", "error", (e as Error).message.slice(0, 200), Math.floor(Date.now() / 1000));
  }
}
