/** Vue d'ensemble : activité des joueurs, conteneurs, incidents, graphes quotidiens. */
import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from "recharts";
import { api, fmtDate, fmtDay, fmtNum, type OverviewData, type ScoreRow } from "../api.js";
import { KIND_LABEL, playerColor } from "../labels.js";
import { Card, Bar, Sev, StateChip, LiveLine } from "../ui.js";
import { useLive, lastCycleLabel } from "../live.js";

export default function OverviewPage() {
  const live = useLive();
  const [ov, setOv] = useState<OverviewData | null>(null);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    Promise.all([api.overview(), api.scores(null, 60)])
      .then(([o, s]) => {
        if (!on) return;
        setOv(o);
        setScores(s.rows);
      })
      .catch((e: Error) => setError(e.message));
    const stop = useLiveRefresh(setOv, setScores);
    return () => {
      on = false;
      stop();
    };
  }, [live.lastCycleAt]);

  // Graphes : une ligne par joueur sur composite quotidien.
  const chartData = useMemo(() => {
    const days = [...new Set(scores.map((s) => s.day))].sort((a, b) => a - b);
    const byDay = new Map<number, Record<string, number | string>>();
    for (const d of days) byDay.set(d, { jour: fmtDay(d) });
    for (const r of scores) {
      const row = byDay.get(r.day)!;
      row[String(r.uid)] = Math.round(r.composite * 10) / 10;
    }
    return [...byDay.values()];
  }, [scores]);

  const players = ov?.players ?? [];
  const topPlayers = players.slice(0, 6);

  if (error) return <div className="card">Erreur de lecture : {error}</div>;
  if (!ov) return <div className="card">Chargement…</div>;

  const states = new Map(ov.containerStates.map((c) => [c.trust_state, c]));

  return (
    <>
      <div className="grid cols-3" style={{ marginBottom: 12 }}>
        <Card title="Joueurs suivis">
          <div className="big">{players.length}</div>
          <div className="muted">{ov.fakeUsers} acteurs environnementaux exclus</div>
        </Card>
        <Card title="Conteneurs">
          <div className="kv"><span className="k">possédés</span><b>{states.get("owned")?.n ?? 0}</b></div>
          <div className="kv"><span className="k">partagés (copropriétaires)</span><b>{states.get("shared")?.n ?? 0}</b></div>
          <div className="kv"><span className="k">publics</span><b>{states.get("public")?.n ?? 0}</b></div>
          <div className="kv"><span className="k">ambigus</span><b>{states.get("ambiguous")?.n ?? 0}</b></div>
          <div className="kv"><span className="k">non suivis</span><b>{states.get("untracked")?.n ?? 0}</b></div>
        </Card>
        <Card title="Ingestion &amp; cycle">
          <LiveLine connected={live.connected} lastCycle={lastCycleLabel(live.lastCycleAt)} />
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>table</th><th className="right">ligne</th><th className="right">rows</th></tr></thead>
            <tbody>
              {ov.cursors.map((c) => (
                <tr key={c.tbl}>
                  <td>{c.tbl}</td>
                  <td className="right">{fmtNum(c.last_rowid)}</td>
                  <td className="right">{fmtNum(c.rows_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 12 }}>
        <Card title="Score composite par joueur (60 jours)">
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 5, right: 8, bottom: 5, left: -18 }}>
                <XAxis dataKey="jour" stroke="#8a909c" fontSize={11} minTickGap={40} />
                <YAxis stroke="#8a909c" fontSize={11} />
                <Tooltip contentStyle={{ background: "#232835", border: "1px solid #2c3340", borderRadius: 6, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {topPlayers.map((p) => (
                  <Line key={p.uid} type="monotone" dataKey={String(p.uid)} name={p.name ?? String(p.uid)} stroke={playerColor(p.uid)} dot={false} strokeWidth={2} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Incidents ouverts par nature">
          {ov.incidentsOpen.length === 0 ? (
            <div className="muted">Aucun incident ouvert. Le pipeline survele en continu.</div>
          ) : (
            ov.incidentsOpen.map((k) => (
              <div key={k.kind} className="flexrow" style={{ marginBottom: 6 }}>
                <Sev sev={k.max_sev} />
                <b>{KIND_LABEL[k.kind] ?? k.kind}</b>
                <Bar value={k.max_sev} />
                <span className="muted">{k.n} incident(s)</span>
              </div>
            ))
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Joueurs (activité et score)">
          <table>
            <thead>
              <tr><th>joueur</th><th className="right">posés</th><th className="right">cassés</th><th className="right">sessions</th><th className="right">conteneurs utilisés</th><th className="right">incidents</th><th>score</th></tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.uid} onClick={() => (location.hash = `#/players/${p.uid}`)}>
                  <td>
                    <span style={{ color: playerColor(p.uid) }}>● </span>
                    {p.name ?? p.uid}
                    {p.is_whitelisted ? " · <exempté>" : ""}
                  </td>
                  <td className="right">{fmtNum(p.total_placed)}</td>
                  <td className="right">{fmtNum(p.total_broken)}</td>
                  <td className="right">{fmtNum(p.sessions)}<div className="muted">dernière : {fmtDate(p.last_session)}</div></td>
                  <td className="right">{fmtNum(p.cont_events)}</td>
                  <td className="right">{fmtNum(p.incidents_as_actor)}</td>
                  <td><Bar value={p.score} max={100} /><span className="muted"> {Math.round(p.score)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Derniers incidents">
          {ov.recent.length === 0 ? (
            <div className="muted">Aucun incident réel enregistré pour le moment.</div>
          ) : (
            <table>
              <thead><tr><th>date</th><th>nature</th><th>sév.</th><th>acteur</th><th>propriétaire</th><th>position</th></tr></thead>
              <tbody>
                {ov.recent.map((r: Record<string, unknown>) => (
                  <tr key={String(r.id)} onClick={() => (location.hash = `#/alerts/${r.id}`)}>
                    <td>{fmtDate(r.created_at as number)}</td>
                    <td>{KIND_LABEL[String(r.kind)] ?? String(r.kind)}</td>
                    <td><Sev sev={Number(r.severity)} /></td>
                    <td>{String(r.actor ?? "?")}</td>
                    <td>{String(r.victim ?? "-")}</td>
                    <td className="muted">
                      {r.x === null ? "-" : `${r.x},${r.z}`}
                      {" "}
                      {(r.x !== null && r.wid != null) ? <a href={`#/squaremap?wid=${Number(r.wid)}&x=${Math.round(Number(r.x))}&z=${Math.round(Number(r.z ?? 0))}`}>carte</a> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 12 }} className="card">
        <h3>État des conteneurs (répartition)</h3>
        <div className="flexrow">
          {["owned", "shared", "public", "ambiguous", "untracked"].map((s) => (
            <span key={s} className="flexrow">
              <StateChip state={s} /> <b>{states.get(s)?.n ?? 0}</b>
              <span className="muted">· {fmtNum(states.get(s)?.volume)} objets</span>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

/** Rafraîchit overview + scores à chaque cycle reçu du flux. */
function useLiveRefresh(setOv: (o: OverviewData) => void, setScores: (s: ScoreRow[]) => void): () => void {
  let stopped = false;
  const tick = async () => {
    try {
      const [o, s] = await Promise.all([api.overview(), api.scores(null, 60)]);
      if (!stopped) {
        setOv(o);
        setScores(s.rows);
      }
    } catch {
      /* la page garde ses dernières valeurs */
    }
  };
  const id = window.setInterval(tick, 30_000);
  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}
