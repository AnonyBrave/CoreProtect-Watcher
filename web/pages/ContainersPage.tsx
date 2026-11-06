/** Conteneurs : filtres (état, propriétaire, zone) et pagination sur l'inventaire de propriété. */
import { useEffect, useState } from "react";
import { api, fmtDate, fmtNum, type ContainerRow, type PlayerRow } from "../api.js";
import { Card, StateChip, Bar } from "../ui.js";

const PAGE = 100;
const STATES = ["", "owned", "public", "ambiguous", "untracked"] as const;
const OPTIONS = ["tous", "possédé", "public", "ambigu", "non suivi"];

export default function ContainersPage() {
  const [state, setState] = useState<string>("");
  const [owner, setOwner] = useState<string>("");
  const [x0, setX0] = useState("");
  const [x1, setX1] = useState("");
  const [z0, setZ0] = useState("");
  const [z1, setZ1] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ContainerRow[]>([]);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.players("", 200).then(setPlayers).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    let on = true;
    const params: Record<string, string | number> = { limit: PAGE, offset: page * PAGE };
    if (state) params.state = state;
    if (owner) params.owner = owner;
    for (const [k, v] of [["x0", x0], ["x1", x1], ["z0", z0], ["z1", z1]] as const) {
      if (v.trim() !== "") params[k] = Number(v);
    }
    api.containers(params).then((r) => { if (on) { setRows(r); setError(null); } }).catch((e: Error) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [state, owner, x0, x1, z0, z1, page]);

  const reset = () => {
    setState(""); setOwner(""); setX0(""); setX1(""); setZ0(""); setZ1(""); setPage(0);
  };

  return (
    <>
      <Card title="Filtres des conteneurs">
        <div className="flexrow" style={{ marginBottom: 8 }}>
          <label>état de propriété</label>
          <select value={state} onChange={(e) => { setState(e.target.value); setPage(0); }}>
            {STATES.map((s, i) => (
              <option key={s} value={s}>{OPTIONS[i]}</option>
            ))}
          </select>

          <label>propriétaire</label>
          <select value={owner} onChange={(e) => { setOwner(e.target.value); setPage(0); }}>
            <option value="">tous</option>
            {players.map((p) => (
              <option key={p.uid} value={String(p.uid)}>{p.name ?? `uid ${p.uid}`}</option>
            ))}
          </select>

          <label>x min</label>
          <input style={{ width: 80 }} value={x0} onChange={(e) => { setX0(e.target.value); setPage(0); }} />
          <label>x max</label>
          <input style={{ width: 80 }} value={x1} onChange={(e) => { setX1(e.target.value); setPage(0); }} />
          <label>z min</label>
          <input style={{ width: 80 }} value={z0} onChange={(e) => { setZ0(e.target.value); setPage(0); }} />
          <label>z max</label>
          <input style={{ width: 80 }} value={z1} onChange={(e) => { setZ1(e.target.value); setPage(0); }} />

          <button type="button" onClick={reset}>effacer les filtres</button>
        </div>
      </Card>

      <Card title={`Inventaire des conteneurs (page ${page + 1})`}>
        {error ? (
          <p>Erreur : {error}</p>
        ) : (
          <>
            <table>
              <thead>
                <tr><th>conteneur</th><th>type</th><th>position</th><th className="right">volume</th><th className="right">dépôts / retraits</th><th>propriétaire</th><th>score de propriété</th><th>état</th></tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.key}>
                    <td>{c.orphan ? "orphelin" : c.key}</td>
                    <td>{c.type ?? "?"}</td>
                    <td><a href={`#/map?wid=${c.wid}&x=${c.x}&z=${c.z}`}>{c.x}, {c.y}, {c.z}</a></td>
                    <td className="right">{fmtNum(c.volume)}</td>
                    <td className="right">{fmtNum(c.deposits)} / {fmtNum(c.withdraws)} ({fmtNum(c.total_events)} év.)</td>
                    <td>{c.owner_uid === null ? "aucun" : <a href={`#/players/${c.owner_uid}`}>{c.owner_name ?? `uid ${c.owner_uid}`}</a>}</td>
                    <td><Bar value={c.score} /> {c.score.toFixed(2)}{c.locked ? " · verrouillé" : ""}</td>
                    <td><StateChip state={c.trust_state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flexrow" style={{ marginTop: 8 }}>
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← page précédente</button>
              <span className="muted">{fmtNum(rows.length)} conteneur(s) affiché(s)</span>
              <button type="button" disabled={rows.length < PAGE} onClick={() => setPage((p) => p + 1)}>page suivante →</button>
            </div>

            <a href="/api/containers?state=owned" className="muted">liste brute (JSON)</a>
          </>
        )}
      </Card>
    </>
  );
}
