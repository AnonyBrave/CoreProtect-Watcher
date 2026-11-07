/** Carte SquareMap : tuiles de l'instance + calques Watcher (incidents, conteneurs, densité chunks,
 *  maisons, joueurs suivis). Le mapping monde -> squaremap se règle dans Réglages. */
import { useEffect, useMemo, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api, squaremapPlayers, squaremapSettings, squaremapWorldSettings, shares as getShares, type IncidentRow, type ShareRow } from "../api.js";
import { playerColor, STATE_LABEL } from "../labels.js";

const DOT_COLOR: Record<string, string> = {
  owned: "#3fa34d",
  public: "#d29922",
  shared: "#b07aa0",
  ambiguous: "#8a909c",
  untracked: "#5c616c",
};

const sevColor = (sev: number): string =>
  sev >= 80 ? "#d64541" : sev >= 60 ? "#d29922" : sev >= 40 ? "#e8c56a" : "#8a909c";

interface WorldCfg {
  url: string;
  worlds: Record<number, string>;
}

interface ViewSettings {
  spawn?: { x: number; z: number };
  zoom?: { def: number; max: number; extra: number };
  player_tracker?: { nameplates?: { heads_url?: string } };
  error?: string;
}

type LayerKey = "chunks" | "houses" | "containers" | "incidents" | "players";

export default function SquareMapPage({ route }: { route: string }) {
  const params = useMemo(() => new URLSearchParams(route.split("?")[1] ?? ""), [route]);

  const [cfg, setCfg] = useState<WorldCfg | null>(null);
  const [worlds, setWorlds] = useState<{ wid: number; name: string }[]>([]);
  const [wid, setWid] = useState<number>(() => Number(params.get("wid") ?? 1));
  const [layersOn, setLayersOn] = useState<Record<LayerKey, boolean>>({
    chunks: true, houses: true, containers: true, incidents: true, players: true,
  });
  const [note, setNote] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [shareRows, setShareRows] = useState<ShareRow[]>([]);

  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const chunksRef = useRef<L.LayerGroup | null>(null);
  const housesRef = useRef<L.LayerGroup | null>(null);
  const contRef = useRef<L.LayerGroup | null>(null);
  const incRef = useRef<L.LayerGroup | null>(null);
  const playersRef = useRef<L.LayerGroup | null>(null);

  // Projection block -> lat/lng de SquareMap : scale = 1/2^zoomMax, lat=(-z*scale), lng=(x*scale).
  const scaleRef = useRef(1 / 8);
  const zoomMaxRef = useRef(3);
  const worldNameRef = useRef<string>("");
  const headsUrlRef = useRef("https://mc-heads.net/avatar/{name}/32");
  const layersRef = useRef(layersOn);
  layersRef.current = layersOn;

  const toLatLng = (x: number, z: number) => L.latLng(-z * scaleRef.current, x * scaleRef.current);

  useEffect(() => {
    squaremapSettings().then((c) => setCfg(c));
    api.worlds().then((w) => setWorlds(w));
  }, []);

  /** Bornes de la vue en blocs (span borné à 4096 comme la carte canvas). */
  function viewBBox(): { x0: number; x1: number; z0: number; z1: number } | null {
    const map = mapRef.current;
    if (!map) return null;
    const s = scaleRef.current;
    const b = map.getBounds();
    const cornerXs = [b.getNorthWest().lng, b.getNorthEast().lng, b.getSouthWest().lng, b.getSouthEast().lng].map((v) => v / s);
    const cornerZs = [b.getNorthWest().lat, b.getNorthEast().lat, b.getSouthWest().lat, b.getSouthEast().lat].map((v) => -v / s);
    const cx = (Math.min(...cornerXs) + Math.max(...cornerXs)) / 2;
    const cz = (Math.min(...cornerZs) + Math.max(...cornerZs)) / 2;
    const spanX = Math.min(4096, Math.max(...cornerXs) - Math.min(...cornerXs));
    const spanZ = Math.min(4096, Math.max(...cornerZs) - Math.min(...cornerZs));
    return { x0: cx - spanX / 2, x1: cx + spanX / 2, z0: cz - spanZ / 2, z1: cz + spanZ / 2 };
  }

  /** Recharge les calques Watcher (densité, maisons, conteneurs, incidents) pour la zone visible. */
  async function loadView() {
    const map = mapRef.current;
    if (!map || !cfg || !worldNameRef.current) return;
    const bb = viewBBox();
    if (!bb) return;
    const on = layersRef.current;

    const x0 = Math.round(bb.x0), x1 = Math.round(bb.x1), z0 = Math.round(bb.z0), z1 = Math.round(bb.z1);
    const data = await api.map(wid, x0, x1, z0, z1);
    const incRes = (await api.incidents({ wid, x0, x1, z0, z1, limit: 200 })).items as IncidentRow[];

    const cLayer = chunksRef.current!;
    cLayer.clearLayers();
    if (on.chunks) {
      for (const c of data.chunks) {
        L.rectangle([toLatLng(c.cx * 16, c.cz * 16), toLatLng(c.cx * 16 + 16, c.cz * 16 + 16)], {
          color: playerColor(c.uid),
          fillOpacity: Math.min(0.45, 0.08 + (c.placed / 200) * 0.37),
          weight: 1,
          opacity: 0.6,
        }).addTo(cLayer);
      }
    }

    const hLayer = housesRef.current!;
    hLayer.clearLayers();
    if (on.houses) {
      for (const c of data.clusters) {
        L.rectangle([toLatLng(c.xmin, c.zmin), toLatLng(c.xmax + 1, c.zmax + 1)], {
          color: playerColor(c.uid),
          weight: c.kind === "territory" ? 2 : 1.5,
          dashArray: c.kind === "territory" ? "6 4" : undefined,
          fillOpacity: 0,
        }).addTo(hLayer);
      }
    }

    const kLayer = contRef.current!;
    kLayer.clearLayers();
    if (on.containers) {
      for (const c of data.containers) {
        const color = DOT_COLOR[c.trust_state] ?? "#5c616c";
        const mk = L.circleMarker(toLatLng(c.x, c.z), {
          radius: Math.min(7, 2.5 + Math.sqrt(c.volume) / 3),
          color, fillColor: color, fillOpacity: 0.8, weight: 1.4,
        });
        mk.bindPopup(
          `<b>${c.key}</b><br/>type : ${c.type ?? "?"}<br/>état : <span class="chip">${c.trust_state}</span>` +
            `<br/>propriétaire : ${c.owner_name ?? "-"} · score ${c.score.toFixed(2)}<br/>volume : ${c.volume} objets<br/>événements : ${c.total_events}<br/><b>copropriétaires</b>`,
        );
        mk.on("click", () => {
          setSelectedKey(c.key);
          void getShares(c.key).then((rows) => setShareRows(rows)).catch(() => setShareRows([]));
        });
        mk.addTo(kLayer);
      }
    }

    const iLayer = incRef.current!;
    iLayer.clearLayers();
    if (on.incidents) {
      for (const i of incRes) {
        if (i.x === null || i.z === null) continue;
        const col = sevColor(i.severity);
        const mk = L.circleMarker(toLatLng(i.x, i.z), {
          radius: 6, color: col, fillColor: col, fillOpacity: 0.5, weight: 2,
        });
        mk.bindPopup(
          `<b>${i.kind}</b> · sévérité ${Math.round(i.severity)}<br/>acteur : ${i.actor ?? "?"}<br/>` +
            (i.victim ? `propriétaire lésé : ${i.victim}<br/>` : "") +
            `x=${i.x} z=${i.z}<br/><a href="#/alerts/${i.id}">ouvrir l'alerte</a>`,
        );
        mk.on("click", () => {
          location.hash = `#/alerts/${i.id}`;
        });
        mk.addTo(iLayer);
      }
    }
  }

  // Création de la carte Leaflet (une seule fois).
  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const map = L.map(el, { crs: L.CRS.Simple, attributionControl: false, preferCanvas: true });
    chunksRef.current = L.layerGroup().addTo(map);
    housesRef.current = L.layerGroup().addTo(map);
    contRef.current = L.layerGroup().addTo(map);
    incRef.current = L.layerGroup().addTo(map);
    playersRef.current = L.layerGroup().addTo(map);
    map.setView([0, 0], 2);

    const refreshView = () => void loadView();
    map.on("moveend zoomend", refreshView);
    mapRef.current = map;

    return () => {
      map.off("moveend zoomend", refreshView);
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
    };
  }, []);

  // Chargement du monde SquareMap : tuiles + spawn/zoom + têtes des joueurs.
  useEffect(() => {
    if (!cfg) return;
    const worldName = cfg.worlds[wid];
    if (!worldName) {
      setNote(`monde ${wid} (${worlds.find((w) => w.wid === wid)?.name ?? "?"}) non mappé vers SquareMap — règle la correspondance dans Réglages`);
      return;
    }
    worldNameRef.current = worldName;

    squaremapWorldSettings(worldName)
      .then((s: ViewSettings) => {
        if (s.error) {
          setNote(`SquareMap injoignable : ${s.error}`);
          return;
        }
        const zoomMax = s.zoom?.max ?? 3;
        const zoomDef = Math.min(s.zoom?.def ?? 2, zoomMax);
        scaleRef.current = 1 / Math.pow(2, zoomMax);
        zoomMaxRef.current = zoomMax;
        headsUrlRef.current = s.player_tracker?.nameplates?.heads_url ?? "https://mc-heads.net/avatar/{name}/32";

        const map = mapRef.current!;
        if (tileRef.current) tileRef.current.remove();
        const t = L.tileLayer(`${cfg.url}/tiles/${worldName}/{z}/{x}_{y}.png`, {
          tileSize: 512, minZoom: 0, maxZoom: zoomMax + (s.zoom?.extra ?? 2), noWrap: true,
        });
        t.addTo(map);
        tileRef.current = t;

        const px = params.get("x");
        const pz = params.get("z");
        if (px !== null && pz !== null) {
          map.setView(toLatLng(Number(px), Number(pz)), zoomDef);
        } else {
          map.setView(toLatLng(s.spawn?.x ?? 0, s.spawn?.z ?? 0), zoomDef);
        }
        setNote(null);
        void loadView();
      })
      .catch((e: Error) => setNote(`SquareMap injoignable : ${e.message}`));

    return () => {
      if (tileRef.current) tileRef.current.remove();
      tileRef.current = null;
    };
  }, [cfg, wid]);

  // Position imposée par le lien ouvert depuis une alerte, un joueur ou un conteneur.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const pwid = params.get("wid");
    if (pwid !== null && Number.isFinite(Number(pwid))) setWid(Number(pwid));
    const px = params.get("x");
    const pz = params.get("z");
    if (px !== null && pz !== null) {
      map.setView(toLatLng(Number(px), Number(pz)), Math.min(map.getZoom(), zoomMaxRef.current + 2));
    }
  }, [params]);

  // Polling des joueurs suivis par SquareMap.
  useEffect(() => {
    let stop = false;
    const poll = () => {
      if (!layersRef.current.players || !worldNameRef.current) return;
      squaremapPlayers()
        .then((players) => {
          if (stop) return;
          const layer = playersRef.current!;
          layer.clearLayers();
          for (const p of players as { name: string; uuid?: string; world: string; x?: number; z?: number }[]) {
            if (!layersRef.current.players) continue;
            if (p.world !== worldNameRef.current || p.x === undefined || p.z === undefined) continue;
            const head = headsUrlRef.current.replace("{uuid}", p.uuid ?? "").replace("{name}", p.name);
            L.marker(toLatLng(p.x, p.z), {
              icon: L.divIcon({ className: "sqplayer", html: `<img src="${head}" width="16" height="16"/><span class="sqname">${p.name}</span>` }),
            })
              .bindTooltip(`${p.name}`, { direction: "top", temporary: true, offset: [0, -8] })
              .addTo(layer);
          }
        })
        .catch(() => {
          /* proxy renvoie [] quand l'instance est injoignable */
        });
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [layersOn.players]);

  const selShare = shareRows.find((r) => r.key === selectedKey) ?? null;

  return (
    <>
      <div className="flexrow" style={{ marginBottom: 10 }}>
        <div>
          <label>monde Watcher</label>
          <select value={wid} onChange={(e) => setWid(Number(e.target.value))}>
            {worlds.map((w) => (
              <option key={w.wid} value={w.wid}>{w.name}</option>
            ))}
          </select>
        </div>
        {(Object.keys(layersOn) as LayerKey[]).map((k) => (
          <label key={k} className="flexrow">
            <input type="checkbox" checked={layersOn[k]} onChange={(e) => setLayersOn({ ...layersOn, [k]: e.target.checked })} />
            {k === "chunks" ? "densité chunks" : k === "houses" ? "maisons" : k === "containers" ? "conteneurs" : k === "incidents" ? "incidents" : "joueurs suivis"}
          </label>
        ))}
        <a href={cfg ? cfg.url : "#"} target="_blank" rel="noreferrer">ouvrir SquareMap en entier</a>
      </div>

      {note ? <p className="muted">{note}</p> : null}

      <div className="grid cols-2" style={{ gridTemplateColumns: "minmax(400px,1fr) 300px", alignItems: "start" }}>
        <div style={{ height: 560 }} ref={divRef} />

        <div className="grid" style={{ gap: 10 }}>
          <div className="card">
            <h3>Conteneur sélectionné</h3>
            {!selectedKey ? (
              <p className="muted">Clique une pastille de conteneur pour afficher ses copropriétaires.</p>
            ) : selShare ? (
              <>
                <div className="kv"><span className="k">clé</span><b>{selShare.key}</b></div>
                <div className="kv"><span className="k">propriétaire</span><b>{selShare.owner_name ?? "-"}</b></div>
                {selShare.members.map((m) => (
                  <div key={m.uid} className="kv">
                    <span className="k">{m.name ?? m.uid}{m.co_owner === 1 ? " · co-propriétaire" : ""}</span>
                    <b>{(m.share * 100).toFixed(0)} % · {m.withdraws} retraits / {m.deposits} dépôts</b>
                  </div>
                ))}
              </>
            ) : (
              <p className="muted">chargement des copropriétaires…</p>
            )}
          </div>

          <div className="card">
            <h3>Légende</h3>
            {Object.entries(DOT_COLOR).map(([k, v]) => (
              <div key={k} className="kv"><span className="k">{STATE_LABEL[k] ?? k}</span><b style={{ color: v }}>●</b></div>
            ))}
            <p className="muted" style={{ marginTop: 6 }}>
              Pastilles incidents : rouge ≥80, orange ≥60, jaune ≥40. Clic = ouvrir l'alerte.
              Fond = densité de blocs posés par chunk, teinté par joueur.
            </p>
          </div>

          <div className="card">
            <h3>Aide</h3>
            <p className="muted">
              Les tuiles viennent de SquareMap, les calques de CoreProtect-Watcher. Si un monde n'apparaît pas,
              ajoute sa correspondance dans Réglages (squaremap_json). Depuis une alerte, le bouton "voir sur la carte"
              centre cette page sur la position.
            </p>
          </div>
        </div>
      </div>

      {cfg ? null : <p className="muted">chargement des réglages SquareMap…</p>}
    </>
  );
}
