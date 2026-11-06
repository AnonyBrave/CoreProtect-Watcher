/** Joueurs : liste avec recherche, fiche complète (score, sessions, conteneurs, incidents, propos). */
import { useEffect, useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from "recharts";
import { api, fmtDate, fmtDay, fmtNum, type PlayerRow, type PlayerDetail, type ScoreRow } from "../api.js";
import { playerColor } from "../labels.js";
import { Card, Sev, StateChip, KindChip } from "../ui.js";

/** Lien carte centrée sur une position (monde par défaut : 1). */
const mapLink = (x: number, z: number, wid = 1): string => `#/map?wid=${wid}&x=${Math.round(x)}&z=${Math.round(z)}`;

/** uid d'origine d'une clé de conteneur physique ("2|-422|84|-219" ou "orph:..."). */
const widOfKey = (key: string): number => {
  const k = key.startsWith("orph:") ? key.slice(5) : key;
  const n = Number(k.split("|")[0]);
  return Number.isFinite(n) ? n : 1;
};

const SESSION_ACTION = (a: number): string => (a === 0 ? "connexion" : "déconnexion");

const SERIES = [
  { key: "theft_s", label: "vol", color: "#d29922" },
  { key: "grief_s", label: "grief", color: "#db4b4b" },
  { key: "anomaly_s", label: "anomalie", color: "#5678a8" },
  { key: "chat_s", label: "propos", color: "#b07aa0" },
  { key: "composite", label: "score quotidien", color: "#3fa34d" },
] as const;

export default function PlayersPage({ route }: { route: string }) {
  const m = route.match(/^#\/players\/(\d+)/);
  const uid = m ? Number(m[1]) : null;
  return uid === null || !Number.isFinite(uid) ? <PlayerList /> : <PlayerDetailView uid={uid} />;
}

function PlayerList() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PlayerRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    api
      .players(q, 200)
      .then((r) => { if (on) { setRows(r); setError(null); } })
      .catch((e: Error) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [q]);

  return (
    <Card title="Joueurs suivis">
      <div className="flexrow" style={{ marginBottom: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nom du joueur…" />
        <span className="muted">{fmtNum(rows.length)} joueur(s) affiché(s)</span>
      </div>
      {error ? (
        <p>Erreur : {error}</p>
      ) : (
        <table>
          <thead>
            <tr><th>joueur</th><th>uid</th><th className="right">blocs posés</th><th className="right">blocs cassés</th><th className="right">incidents</th><th>dernière connexion</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.uid} onClick={() => { location.hash = `#/players/${p.uid}`; }}>
                <td>
                  <span style={{ color: playerColor(p.uid) }}>● </span>
                  {p.name ?? `uid ${p.uid}`}
                  {p.is_whitelisted ? " · protégé" : ""}
                </td>
                <td>{p.uid}</td>
                <td className="right">{fmtNum(p.total_placed)}</td>
                <td className="right">{fmtNum(p.total_broken)}</td>
                <td className="right">{fmtNum(p.incidents ?? 0)}</td>
                <td>{fmtDate(p.last_seen ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function PlayerDetailView({ uid }: { uid: number }) {
  const [d, setD] = useState<PlayerDetail | null>(null);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    Promise.all([api.playerDetail(uid), api.scores(uid, 90)])
      .then(([det, sc]) => { if (on) { setD(det); setScores(sc.rows); setError(null); } })
      .catch((e: Error) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [uid]);

  const chartRows = scores.map((r) => ({ ...r, jour: fmtDay(r.day) }));
  const totals = Object.fromEntries(
    SERIES.map((s) => [s.key, scores.reduce((a, r) => a + (Number(r[s.key as keyof ScoreRow]) || 0), 0)]),
  ) as Record<string, number>;

  if (error) return <Card title={`Joueur ${uid}`}>Erreur : {error}</Card>;
  if (!d) return <Card title={`Joueur ${uid}`}>chargement de la fiche…</Card>;

  const last = d.sessions[0];

  return (
    <>
      <div className="flexrow" style={{ marginBottom: 8 }}>
        <a href="#/players">← liste des joueurs</a>
        {last ? <a href={mapLink(last.x ?? 0, last.z ?? 0, last.wid ?? 1)}>voir sa dernière position sur la carte</a> : null}
      </div>

      <div className="grid cols-2">
        <Card title={`Fiche · ${d.base.name ?? `uid ${d.base.uid}`}`}>
          <div className="kv"><span className="k">uid</span><b>{d.base.uid}</b></div>
          <div className="kv"><span className="k">statut</span><b>{d.base.is_whitelisted ? "protégé (exonéré d'alertes)" : "surveillée"}</b></div>
          <div className="kv"><span className="k">uuid</span><b>{d.base.uuid ?? "-"}</b></div>
          <div className="kv"><span className="k">blocs posés</span><b>{fmtNum(d.base.total_placed)}</b></div>
          <div className="kv"><span className="k">blocs cassés</span><b>{fmtNum(d.base.total_broken)}</b></div>
          <div className="kv"><span className="k">première trace</span><b>{fmtDate(d.base.first_seen)}</b></div>
          <div className="kv"><span className="k">dernière trace</span><b>{fmtDate(d.base.last_seen)}</b></div>
        </Card>

        <Card title="Score quotidien (90 derniers jours)">
          {chartRows.length === 0 ? (
            <p className="muted">aucun score enregistré sur la période</p>
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={chartRows} margin={{ top: 5, right: 8, bottom: 0, left: -18 }}>
                <XAxis dataKey="jour" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {SERIES.map((s) => (
                  <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} dot={false} strokeWidth={s.key === "composite" ? 2.4 : 1.4} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
          <div className="flexrow">
            {SERIES.map((s) => (
              <span key={s.key} className="muted">{s.label} : {fmtNum(Math.round(totals[s.key] ?? 0))}</span>
            ))}
          </div>
        </Card>

        <Card title="Sessions récentes">
          <table>
            <thead><tr><th>date</th><th>monde</th><th>position</th><th>événement</th></tr></thead>
            <tbody>
              {d.sessions.map((s, i) => (
                <tr key={`${s.time}:${i}`}>
                  <td>{fmtDate(s.time)}</td>
                  <td>{s.wid ?? "-"}</td>
                  <td><a href={mapLink(s.x ?? 0, s.z ?? 0, s.wid ?? 1)}>{s.x}, {s.y}, {s.z}</a></td>
                  <td>{SESSION_ACTION(s.action)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Maisons et territoires">
          {d.homes.length === 0 ? (
            <p className="muted">aucune zone construite détectée</p>
          ) : (
            <table>
              <thead><tr><th>nature</th><th>monde</th><th>x</th><th>z</th><th className="right">blocs posés</th><th className="right">types fonctionnels</th></tr></thead>
              <tbody>
                {d.homes.map((h) => (
                  <tr key={`${h.wid}:${h.id}`}>
                    <td>{h.kind === "territory" ? "territoire" : "maison"} · <a href={mapLink((h.xmin + h.xmax) / 2, (h.zmin + h.zmax) / 2, h.wid)}>voir</a></td>
                    <td>{h.world ?? h.wid}</td>
                    <td>{h.xmin}..{h.xmax}</td>
                    <td>{h.zmin}..{h.zmax}</td>
                    <td className="right">{fmtNum(h.blocks_placed)}</td>
                    <td className="right">{h.distinct_types} (dont {h.functional_count})</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Conteneurs utilisés">
          {d.usage.length === 0 ? (
            <p className="muted">aucun usage de conteneur enregistré</p>
          ) : (
            <table>
              <thead><tr><th>conteneur</th><th>type</th><th className="right">dépôts</th><th className="right">retraits</th><th className="right">volume</th><th>dernier usage</th><th>propriétaire</th></tr></thead>
              <tbody>
                {d.usage.map((u) => (
                  <tr key={u.key}>
                    <td><a href={mapLink(u.x, u.z, widOfKey(u.key))}>{u.key}</a></td>
                    <td>{u.type ?? "?"}</td>
                    <td className="right">{fmtNum(u.deposits)}</td>
                    <td className="right">{fmtNum(u.withdraws)}</td>
                    <td className="right">{fmtNum(u.volume)}</td>
                    <td>{fmtDate(u.last_time)}</td>
                    <td>
                      {u.owner_uid === null ? (
                        "aucun"
                      ) : u.owner_uid === uid ? (
                        "lui-même"
                      ) : (
                        <a href={`#/players/${u.owner_uid}`}>{u.owner_uid}</a>
                      )}{" "}
                      <StateChip state={u.trust_state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Incidents (40 derniers)">
          {d.incidents.length === 0 ? (
            <p className="muted">aucun incident réel impliquant ce joueur</p>
          ) : (
            <table>
              <thead><tr><th>date</th><th>nature</th><th>sévérité</th><th>rôle</th><th>victime</th><th className="right">quantité</th><th>conteneur</th></tr></thead>
              <tbody>
                {d.incidents.map((i) => (
                  <tr key={i.id} onClick={() => { location.hash = `#/alerts/${i.id}`; }}>
                    <td>{fmtDate(i.created_at)}</td>
                    <td><KindChip kind={i.kind} /></td>
                    <td><Sev sev={i.severity} /></td>
                    <td>{i.victim_uid === uid ? "a subi" : "a commis"}</td>
                    <td>{i.victim ?? "-"}</td>
                    <td className="right">{fmtNum(i.amount)}</td>
                    <td><a href={`#/alerts/${i.id}`}>{i.container_key ?? "-"}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Propos surveillés (30 derniers)">
          {d.chats.length === 0 ? (
            <p className="muted">aucun message surveillé</p>
          ) : (
            <table>
              <thead><tr><th>date</th><th>position</th><th>message</th></tr></thead>
              <tbody>
                {d.chats.map((c, i) => (
                  <tr key={`${c.time}:${i}`}>
                    <td>{fmtDate(c.time)}</td>
                    <td><a href={mapLink(c.x ?? 0, c.z ?? 0, c.wid ?? 1)}>{c.x}, {c.z}</a></td>
                    <td>{c.msg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Commandes surveillées (20 dernières)">
          {d.commands.length === 0 ? (
            <p className="muted">aucune commande surveillée</p>
          ) : (
            <table>
              <thead><tr><th>date</th><th>position</th><th>commande</th></tr></thead>
              <tbody>
                {d.commands.map((c, i) => (
                  <tr key={`${c.time}:${i}`}>
                    <td>{fmtDate(c.time)}</td>
                    <td><a href={mapLink(c.x ?? 0, c.z ?? 0, c.wid ?? 1)}>{c.x}, {c.z}</a></td>
                    <td><code>{c.cmd}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

      </div>

    </>
  );
}
