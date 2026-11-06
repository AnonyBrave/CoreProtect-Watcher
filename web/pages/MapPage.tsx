/** Carte : densité de blocs par chunk, emprises des maisons, conteneurs par état de propriété. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtDate, type MapData } from "../api.js";
import { playerColor, stateClass } from "../labels.js";
import { Card, StateChip } from "../ui.js";

const CANVAS_W = 1040;
const CANVAS_H = 620;

interface Selected {
  key: string;
  x: number;
  y: number;
  z: number;
  type: string | null;
  owner_name: string | null;
  owner_uid: number | null;
  score: number;
  trust_state: string;
  volume: number;
  total_events: number;
}

const DOT_COLOR: Record<string, string> = {
  owned: "#3fa34d",
  public: "#d29922",
  ambiguous: "#8a909c",
  untracked: "#5c616c",
};

export default function MapPage({ route }: { route: string }) {
  const params = useMemo(() => new URLSearchParams(route.split("?")[1] ?? ""), [route]);

  const [worlds, setWorlds] = useState<{ wid: number; name: string }[]>([]);
  const [wid, setWid] = useState<number>(Number(params.get("wid") ?? 1));
  const [centerX, setCenterX] = useState(Number(params.get("x") ?? -480));
  const [centerZ, setCenterZ] = useState(Number(params.get("z") ?? -256));
  const [bpp, setBpp] = useState(2); // blocs par pixel
  const [data, setData] = useState<MapData | null>(null);
  const [hovered, setHovered] = useState<{ key: string; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => {
    api.worlds().then((w) => setWorlds(w));
  }, []);

  // Synchronisation sur l'adresse : un lien carte (joueur, conteneur, incident) recentre la vue.
  useEffect(() => {
    const w = Number(params.get("wid") ?? 1);
    if (Number.isFinite(w)) setWid(w);
    const x = params.get("x");
    const z = params.get("z");
    if (x !== null && Number.isFinite(Number(x))) setCenterX(Number(x));
    if (z !== null && Number.isFinite(Number(z))) setCenterZ(Number(z));
  }, [params]);

  // Bornes demandées à l'API (span max 4096 blocs, contrôlé par le zoom).
  const bbox = useMemo(() => {
    const wSpan = CANVAS_W * bpp;
    const hSpan = CANVAS_H * bpp;
    const span = Math.max(wSpan, hSpan);
    const k = span > 4096 ? 4096 / span : 1;
    return {
      x0: centerX - (wSpan * k) / 2,
      x1: centerX + (wSpan * k) / 2,
      z0: centerZ - (hSpan * k) / 2,
      z1: centerZ + (hSpan * k) / 2,
    };
  }, [centerX, centerZ, bpp]);

  useEffect(() => {
    let on = true;
    api.map(wid, bbox.x0, bbox.x1, bbox.z0, bbox.z1).then((d) => {
      if (on) setData(d);
    });
    return () => {
      on = false;
    };
  }, [wid, bbox]);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !data) return;
    const ctx = cv.getContext("2d")!;
    const sx = CANVAS_W / (bbox.x1 - bbox.x0);
    const sz = CANVAS_H / (bbox.z1 - bbox.z0);
    const toPx = (x: number, z: number) => [(x - bbox.x0) * sx, (z - bbox.z0) * sz];

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#0e1116";
    ctx.fillRect(0, 0, cv.width, cv.height);

    // Densité de blocs posés par chunk (teintée par joueur).
    const maxPlaced = Math.max(1, ...data.chunks.map((c) => c.placed));
    for (const c of data.chunks) {
      const [px, pz] = toPx(c.cx * 16, c.cz * 16);
      const w = 16 * sx;
      const h = 16 * sz;
      ctx.globalAlpha = Math.min(0.55, 0.08 + (c.placed / maxPlaced) * 0.5);
      ctx.fillStyle = playerColor(c.uid);
      ctx.fillRect(px, pz, w, h);
    }
    ctx.globalAlpha = 1;

    // Emprises des clusters (maisons / territoires).
    for (const c of data.clusters) {
      const [px, pz] = toPx(c.xmin, c.zmin);
      const w = (c.xmax - c.xmin + 1) * sx;
      const h = (c.zmax - c.zmin + 1) * sz;
      ctx.strokeStyle = playerColor(c.uid);
      ctx.lineWidth = c.kind === "territory" ? 2 : 1.5;
      ctx.setLineDash(c.kind === "territory" ? [6, 4] : []);
      ctx.strokeRect(px, pz, w, h);
      ctx.setLineDash([]);
      if (w > 70) {
        ctx.fillStyle = "#e8ecf1";
        ctx.font = "12px sans-serif";
        ctx.fillText(`${c.name ?? c.uid} (${c.kind === "territory" ? "territoire" : "maison"})`, px + 4, pz + 14);
      }
    }

    // Conteneurs : pastille selon l'état de propriété.
    for (const k of data.containers) {
      const [px, pz] = toPx(k.x, k.z);
      ctx.beginPath();
      const r = Math.min(6, 2.4 + Math.sqrt(k.volume) / 3);
      ctx.arc(px, pz, r, 0, Math.PI * 2);
      ctx.fillStyle = DOT_COLOR[k.trust_state] ?? "#5c616c";
      ctx.fill();
      if (selected && k.key === selected.key) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Réticule de la position suivie.
    const [mx, mz] = toPx(centerX, centerZ);
    ctx.strokeStyle = "rgba(232,236,241,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx, CANVAS_H);
    ctx.moveTo(0, mz);
    ctx.lineTo(CANVAS_W, mz);
    ctx.stroke();

    const tipEl = document.getElementById("map-tip");
    if (tipEl && hovered) {
      const cont = data.containers.find((c) => c.key === hovered.key);
      tipEl.innerHTML = cont
        ? `<b>${cont.key}</b><br/>type : ${cont.type ?? "?"}<br/>état : <span class="chip ${stateClass(cont.trust_state)}">${cont.trust_state}</span><br/>propriétaire : ${cont.owner_name ?? "-"} · score ${cont.score.toFixed(2)}<br/>volume : ${cont.volume} objets<br/>événements : ${cont.total_events}`
        : "";
    }
  }, [data, bbox, centerX, centerZ, hovered, selected]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Pan (glisser) et zoom (molette).
  const drag = useRef<{ x: number; y: number; cx: number; cz: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, cx: centerX, cz: centerZ };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (drag.current) {
      const rect = cv.getBoundingClientRect();
      const sx = (bbox.x1 - bbox.x0) / rect.width;
      const sz = (bbox.z1 - bbox.z0) / rect.height;
      setCenterX(Math.round(drag.current.cx + (e.clientX - drag.current.x) * sx));
      setCenterZ(Math.round(drag.current.cz + (e.clientY - drag.current.y) * sz));
    }
    // Le survol détecte le conteneur physique le plus proche du curseur.
    const rect = cv.getBoundingClientRect();
    const scaleX = (bbox.x1 - bbox.x0) / rect.width;
    const bx = bbox.x0 + ((e.clientX - rect.left) / rect.width) * (bbox.x1 - bbox.x0);
    const bz = bbox.z0 + ((e.clientY - rect.top) / rect.height) * (bbox.z1 - bbox.z0);

    let bestKey: string | null = null;
    let bestD = Infinity;
    for (const c of data?.containers ?? []) {
      const d = Math.hypot(c.x - bx, c.z - bz);
      if (d < bestD) {
        bestD = d;
        bestKey = c.key;
      }
    }
    // Seuil de clic-survol : 7 blocs à l'écran.
    const ok = bestKey !== null && bestD * scaleX <= 7;
    setHovered(ok ? { key: bestKey!, x: e.clientX - rect.left + 10, y: e.clientY - rect.top + 8 } : null);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const moved = drag.current && Math.hypot(e.clientX - drag.current.x, e.clientY - drag.current.y) > 3;
    drag.current = null;
    if (!moved && hovered && data) {
      const cont = data.containers.find((c) => c.key === hovered.key);
      setSelected(cont ? { ...cont } : null);
    }
  };

  const clustersList = data?.clusters ?? [];

  return (
    <>
      <div className="flexrow" style={{ marginBottom: 10 }}>
        <div>
          <label>monde</label>
          <select value={wid} onChange={(e) => setWid(Number(e.target.value))}>
            {worlds.map((w) => (
              <option key={w.wid} value={w.wid}>{w.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label>x</label>
          <input value={centerX} onChange={(e) => setCenterX(Number(e.target.value))} style={{ width: 90 }} />
        </div>
        <div>
          <label>z</label>
          <input value={centerZ} onChange={(e) => setCenterZ(Number(e.target.value))} style={{ width: 90 }} />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label>zoom : {bpp.toFixed(2)} blocs / pixel</label>
          <input type="range" min={0.5} max={4} step={0.25} value={bpp} onChange={(e) => setBpp(Number(e.target.value))} style={{ width: "100%" }} />
        </div>
        <button onClick={() => { setBpp(1); }}>zoom rapproché</button>
        <button onClick={() => { setCenterX(-480); setCenterZ(-256); setBpp(2); }}>territoire d'AnonyBrave</button>
      </div>

      <div className="grid cols-2" style={{ gridTemplateColumns: "minmax(360px,1fr) 290px", alignItems: "start" }}>
        <div className="mapwrap">
          <canvas
            ref={canvasRef}
            className="map"
            width={CANVAS_W}
            height={CANVAS_H}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => { drag.current = null; setHovered(null); }}
          />
          <div id="map-tip" className="tooltip" />
        </div>

        <div className="grid" style={{ gap: 10 }}>
          <Card title="Conteneur sélectionné">
            {!selected ? (
              <div className="muted">Cliquez une pastille sur la carte pour lire sa fiche.</div>
            ) : (
              <>
                <div className="kv"><span className="k">clé</span><b>{selected.key}</b></div>
                <div className="kv"><span className="k">position</span><b>x={selected.x} y={selected.y} z={selected.z}</b></div>
                <div className="kv"><span className="k">type</span><b>{selected.type ?? "?"}</b></div>
                <div className="kv"><span className="k">état</span><StateChip state={selected.trust_state} /></div>
                <div className="kv"><span className="k">propriétaire</span><b>{selected.owner_name ?? "-"}</b></div>
                <div className="kv"><span className="k">score</span><b>{selected.score.toFixed(2)}</b></div>
                <div className="kv"><span className="k">volume</span><b>{selected.volume} objets</b></div>
                <div className="kv"><span className="k">événements</span><b>{selected.total_events}</b></div>
                {selected.owner_uid !== null ? (
                  <a href={`#/players/${selected.owner_uid}`}>voir le propriétaire</a>
                ) : null}
              </>
            )}
          </Card>

          <Card title="Emprises visibles">
            <table>
              <thead><tr><th>joueur</th><th>nature</th><th className="right">blocs posés</th></tr></thead>
              <tbody>
                {clustersList.map((c) => (
                  <tr key={`${c.uid}-${c.xmin}-${c.zmin}`} onClick={() => { setCenterX(Math.round((c.xmin + c.xmax) / 2)); setCenterZ(Math.round((c.zmin + c.zmax) / 2)); }}>
                    <td>{c.name ?? c.uid}</td>
                    <td>{c.kind === "territory" ? "territoire" : "maison"}</td>
                    <td className="right">{c.blocks_placed.toLocaleString("fr-FR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Légende">
            <div className="kv"><span className="k">possédé</span><b style={{ color: DOT_COLOR.owned }}>●</b></div>
            <div className="kv"><span className="k">public</span><b style={{ color: DOT_COLOR.public }}>●</b></div>
            <div className="kv"><span className="k">ambigu</span><b style={{ color: DOT_COLOR.ambiguous }}>●</b></div>
            <div className="kv"><span className="k">non suivi</span><b style={{ color: DOT_COLOR.untracked }}>●</b></div>
            <div className="muted" style={{ marginTop: 6 }}>Fond = densité de blocs posés par chunk, teinté par joueur.</div>
          </Card>

          {data ? (
            <div className="card">
              <h3>Zone courante</h3>
              <div className="kv"><span className="k">vue</span><b>x {Math.round(bbox.x0)}..{Math.round(bbox.x1)} · z {Math.round(bbox.z0)}..{Math.round(bbox.z1)}</b></div>
              <div className="kv"><span className="k">conteneurs affichés</span><b>{data.containers.length}</b></div>
              <div className="kv"><span className="k">chunks peuplés</span><b>{data.chunks.length}</b></div>
            </div>
          ) : (
            <div className="card">chargement de la zone…</div>
          )}

        </div>
      </div>

      {data?.tooWide ? <p className="muted" style={{ marginTop: 10 }}>Vue trop large : réduisez le zoom. La carte découpe l'espace en blocs de 4096.</p> : null}
    </>
  );
}
