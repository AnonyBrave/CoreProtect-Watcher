/** Client HTTP de CoreProtect-Watcher : lecture des routes /api/*, écritures avec jeton d'administration. */

const TOKEN_KEY = "cp-admin-token";

export function getAdminToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "coreprotect-watcher-admin";
}

export function setAdminToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${path} → http ${r.status}`);
  return (await r.json()) as T;
}

const adminHeaders = (): Record<string, string> => ({
  "content-type": "application/json",
  "x-admin-token": getAdminToken(),
});

export interface PlayerRow {
  uid: number;
  name: string | null;
  is_whitelisted: number;
  total_placed: number;
  total_broken: number;
  /** présents sur /api/players uniquement */
  last_seen?: number | null;
  incidents?: number;
}

/** Fiche complète d'un joueur (route /api/players/:uid). */
export interface PlayerDetail {
  base: { uid: number; uuid: string | null; name: string | null; is_whitelisted: number; total_placed: number; total_broken: number; first_seen: number | null; last_seen: number | null };
  sessions: { time: number; wid: number | null; x: number | null; y: number | null; z: number | null; action: number }[];
  usage: { key: string; deposits: number; withdraws: number; events: number; volume: number; first_time: number | null; last_time: number | null; x: number; y: number; z: number; owner_uid: number | null; trust_state: string; locked: number; type: string | null }[];
  incidents: { id: number; kind: string; severity: number; status: string; created_at: number; victim_uid: number | null; victim: string | null; container_key: string | null; amount: number | null }[];
  chats: { time: number; wid: number | null; x: number | null; z: number | null; msg: string }[];
  commands: { time: number; wid: number | null; x: number | null; z: number | null; cmd: string }[];
  homes: { id: number; kind: string; wid: number; world: string | null; xmin: number; xmax: number; zmin: number; zmax: number; blocks_placed: number; functional_count: number; distinct_types: number }[];
}

/** Incident complet (route /api/incidents/:id). */
export interface FullIncident {
  id: number;
  kind: string;
  severity: number;
  status: string;
  note: string | null;
  created_at: number;
  uid: number | null;
  victim_uid: number | null;
  wid: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  item_id: number | null;
  container_key: string | null;
  amount: number | null;
  window_start: number | null;
  window_end: number | null;
  event_rowid: number;
  test: number;
  actor_name: string | null;
  victim_name: string | null;
  world_name: string | null;
  evidence: Record<string, unknown>;
}

/** Réglages chargés (clés JSON déjà parsées). */
export interface SettingsData {
  settings: Record<string, unknown>;
  keys: string[];
  adminToken: string;
}

export interface OverviewData {
  players: (PlayerRow & { sessions: number; last_session: number | null; cont_events: number; incidents_as_actor: number; score: number })[];
  containerStates: { trust_state: string; n: number; volume: number }[];
  incidentsOpen: { kind: string; n: number; max_sev: number }[];
  recent: Record<string, unknown>[];
  cursors: { tbl: string; last_rowid: number; last_sync_at: number | null; rows_total: number }[];
  lastCycleAt: number | null;
  sseClients: number;
  fakeUsers: number;
}

export interface IncidentRow {
  id: number;
  kind: string;
  severity: number;
  status: string;
  note: string | null;
  created_at: number;
  actor: string | null;
  victim: string | null;
  world: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  container_key: string | null;
  amount: number | null;
  window_start: number | null;
  window_end: number | null;
}

export interface ContainerRow {
  key: string;
  wid: number;
  x: number;
  y: number;
  z: number;
  type: string | null;
  orphan: number;
  placed_uid: number | null;
  total_events: number;
  deposits: number;
  withdraws: number;
  volume: number;
  first_seen: number | null;
  last_seen: number | null;
  owner_uid: number | null;
  owner_name: string | null;
  score: number;
  trust_state: string;
  locked: number;
}

export interface MapData {
  clusters: { uid: number; name: string | null; kind: string; xmin: number; xmax: number; zmin: number; zmax: number; blocks_placed: number }[];
  containers: { key: string; x: number; y: number; z: number; type: string | null; orphan: number; total_events: number; volume: number; owner_uid: number | null; owner_name: string | null; score: number; trust_state: string }[];
  chunks: { cx: number; cz: number; uid: number; name: string | null; placed: number }[];
  tooWide?: boolean;
}

export interface ScoreRow {
  uid: number;
  name: string | null;
  day: number;
  theft_s: number;
  grief_s: number;
  anomaly_s: number;
  chat_s: number;
  dupe_s: number;
  composite: number;
}

export const api = {
  overview: () => json<OverviewData>("/api/overview"),
  worlds: () => json<{ wid: number; name: string }[]>("/api/worlds"),
  players: (q = "", limit = 200, dir = "desc") =>
    json<PlayerRow[]>(`/api/players?q=${encodeURIComponent(q)}&limit=${limit}&dir=${dir}`),
  playerDetail: (uid: number) => json<PlayerDetail>(`/api/players/${uid}`),
  containers: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return json<ContainerRow[]>(`/api/containers?${qs.toString()}`);
  },
  incidents: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return json<{ items: IncidentRow[]; total: number }>(`/api/incidents?${qs.toString()}`);
  },
  incidentDetail: (id: number) => json<FullIncident>(`/api/incidents/${id}`),
  patchIncident: (id: number, body: { status?: string; note?: string }) =>
    json<FullIncident>(`/api/incidents/${id}`, { method: "POST", headers: adminHeaders(), body: JSON.stringify(body) }),
  houses: () => json<Record<string, unknown>[]>("/api/houses"),
  map: (wid: number, x0: number, x1: number, z0: number, z1: number) =>
    json<MapData>(`/api/map?wid=${wid}&x0=${Math.round(x0)}&x1=${Math.round(x1)}&z0=${Math.round(z0)}&z1=${Math.round(z1)}`),
  scores: (uid: number | null, days = 60) =>
    json<{ rows: ScoreRow[]; day: number }>(`/api/scores?days=${days}${uid !== null ? `&uid=${uid}` : ""}`),
  settings: () => json<SettingsData>("/api/settings"),
  saveSettings: (body: Record<string, unknown>) =>
    json<{ ok: boolean; changed: string[] }>("/api/settings", { method: "POST", headers: adminHeaders(), body: JSON.stringify(body) }),
  cycleRun: () => json<{ ok: boolean }>(`/api/cycle/run`, { method: "POST", headers: adminHeaders(), body: "{}" }),
  imports: () => json<{ dir: string; files: ImportFile[] }>("/api/imports"),
};

export const csvUrl = (kind = ""): string => `/api/export.csv${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`;

/** Copropriétaires des conteneurs partagés (route /api/shares). */
export interface ShareMember {
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

export interface ShareRow {
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
  members: ShareMember[];
}

export const shares = (key?: string): Promise<ShareRow[]> => json<ShareRow[]>(`/api/shares${key ? `?key=${encodeURIComponent(key)}` : ""}`);

/** Dossier d'import SQL et ledger des fichiers traités (route /api/imports). */
export interface ImportFile {
  file: string;
  bytes: number | null;
  mtime: number | null;
  rows: number | null;
  state: "done" | "pending" | "failed";
}

export const imports = (): Promise<{ dir: string; files: ImportFile[] }> => json("/api/imports");

/** Proxy SquareMap : instance configurée, mondes de l'instance, spawn/zoom d'un monde, joueurs suivis. */
export interface SquaremapCfg {
  url: string;
  worlds: Record<number, string>;
}

export const squaremapSettings = (): Promise<SquaremapCfg> => json("/api/squaremap/settings");
export const squaremapWorldsList = (): Promise<{ worlds: { name: string; display_name?: string }[] }> => json("/api/squaremap/worlds");
export const squaremapWorldSettings = (world: string): Promise<Record<string, unknown>> =>
  json(`/api/squaremap/world/${encodeURIComponent(world)}`);
export const squaremapPlayers = (): Promise<SqPlayer[]> => json("/api/squaremap/players");

export interface SqPlayer {
  name: string;
  uuid?: string;
  world: string;
  x?: number;
  z?: number;
  yaw?: number;
}

/** Formatage FR des dates et nombres. */
export const fmtDate = (epoch: number | null): string =>
  epoch === null ? "-" : new Date(epoch * 1000).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

export const fmtDay = (dayEpoch: number): string =>
  new Date(dayEpoch * 86400000).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });

export const fmtNum = (n: number | null | undefined): string =>
  n === null || n === undefined ? "-" : n.toLocaleString("fr-FR");
