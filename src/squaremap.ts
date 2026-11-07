/** Proxy SquareMap côté serveur : les JSON du serveur de tuiles sont récupérés par Watcher
 *  (pas de CORS côté navigateur), mis en cache court pour le polling de la carte. */
import { getSetting } from "./db.js";

interface SqCfg {
  url?: string;
  worlds?: Record<string, string>;
}

export interface SquaremapConfig {
  url: string;
  worlds: Record<number, string>;
}

/** Réglage squaremap_json : base de l'instance + correspondance wid Watcher -> monde squaremap. */
export function squaremapConfig(): SquaremapConfig {
  const s = (getSetting<SqCfg>("squaremap_json", {} as SqCfg) ?? {}) as SqCfg;
  const url = (s.url ?? "https://dynmap.anonybrave.fr").trim().replace(/\/+$/, "");
  const worlds: Record<number, string> = {};
  for (const [k, v] of Object.entries(s.worlds ?? {})) {
    const wid = Number(k);
    if (Number.isFinite(wid) && typeof v === "string") worlds[wid] = v;
  }
  return { url, worlds };
}

const cache = new Map<string, { at: number; data: unknown }>();

/** GET JSON sur le serveur SquareMap, avec court cache (les polling UI sont rapides). */
export async function sqFetch(path: string, ttlMs = 15000): Promise<unknown> {
  const key = path;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const url = `${squaremapConfig().url}${path}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`squaremap ${path} → http ${r.status}`);
  const data = (await r.json()) as unknown;
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Liste des mondes de l'instance (settings.json global) : sert à préremplir le mapping. */
export function squaremapWorlds(): Promise<{ worlds: { name: string; display_name?: string; type?: string }[] }> {
  return sqFetch("/tiles/settings.json", 60000).then((d) => d as { worlds: { name: string; display_name?: string; type?: string }[] });
}

/** Réglages d'un monde (spawn, zoom max/def, player_tracker.heads_url…). */
export function squaremapWorldSettings(worldName: string): Promise<unknown> {
  return sqFetch(`/tiles/${encodeURIComponent(worldName)}/settings.json`, 60000);
}

/** Joueurs connectés suivis par SquareMap (players.json global). */
export function squaremapPlayers(): Promise<unknown> {
  return sqFetch("/tiles/players.json", 2000);
}

/** Marqueurs d'un monde (markers.json), pour la superposition live. */
export function squaremapMarkers(worldName: string): Promise<unknown> {
  return sqFetch(`/tiles/${encodeURIComponent(worldName)}/markers.json`, 5000);
}
