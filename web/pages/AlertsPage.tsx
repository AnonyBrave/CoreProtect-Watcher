/** Alertes : filtres, flux en direct, preuve décodée et suivi administrateur (statut + note). */
import { useEffect, useState } from "react";
import { api, csvUrl, fmtDate, fmtNum, type FullIncident, type IncidentRow } from "../api.js";
import { KIND_LABEL, STATUS_LABEL, coordText } from "../labels.js";
import { Card, Sev, StatusChip, KindChip, Toast } from "../ui.js";
import { useLive } from "../live.js";

const KINDS = ["", "theft", "theft_shared", "dupe", "grief", "anomaly", "chat"] as const;
const STATUSES = ["", "new", "seen", "closed"] as const;
const PAGE = 60;

/** Libellés français des clés de preuve (evidence_json) par détecteur. */
const EV_LABELS: Record<string, string> = {
  container: "conteneur visé",
  owner_uid: "propriétaire (uid)",
  owner_name: "propriétaire",
  items: "objets retirés",
  total_amount: "quantité totale",
  events: "événements d'événement",
  event_rowids: "ligne(s) d'événement",
  terms: "barème de sévérité",
  home_of_container: "maison du conteneur",
  transfer: "corrélation de transfert",
  chat_commands: "propos et commandes proches",
  cluster_id: "cluster visé",
  cluster_kind: "nature du cluster",
  bounds: "emprise du cluster",
  victim_name: "victime",
  blocks: "blocs cassés (10 premiers)",
  broken_count: "nombre de blocs cassés",
  session_rowids: "lignes de session",
  logins: "connexions",
  logouts: "déconnexions",
  positions: "positions relevées",
  tnt_count: "TNT posés",
  message: "message",
  keywords: "mots surveillés trouvés",
  window_sec: "fenêtre de corrélation (secondes)",
  command: "commande",
  prefix: "préfixe surveillé",
};

const TERM_LABELS: Record<string, string> = {
  base: "base",
  amount_part: "quantité volée",
  count_part: "nombre d'actions",
  rarity_bonus: "rareté des objets",
  house_bonus: "zone maison / territoire",
  stranger_bonus: "joueur jamais construit là",
  session_bonus: "session ouverte sur place",
  login_part: "connexions",
  keyword_part: "mots surveillés",
};

const isScalar = (v: unknown): boolean => v === null || typeof v !== "object";

export default function AlertsPage({ route }: { route: string }) {
  const m = route.match(/^#\/alerts\/(\d+)/);
  const selId = m ? Number(m[1]) : null;

  const live = useLive();
  const [kind, setKind] = useState<string>("");
  const [status, setStatus] = useState<string>("new");
  const [minSev, setMinSev] = useState("0");
  const [page, setPage] = useState(0);

  const [items, setItems] = useState<IncidentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<FullIncident | null>(null);
  const [note, setNote] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // liste : rechargée à chaque cycle pour suivre le temps réel
  useEffect(() => {
    let on = true;
    api
      .incidents({ kind, status, minSeverity: Number(minSev) || 0, limit: PAGE, offset: page * PAGE })
      .then((r) => { if (on) { setItems(r.items); setTotal(r.total); } })
      .catch((e: Error) => { if (on) setToast(e.message); });
    return () => { on = false; };
  }, [kind, status, minSev, page, live.lastCycleAt]);

  // détail de l'incident sélectionné dans l'adresse
  useEffect(() => {
    if (selId === null) { setDetail(null); return; }
    let on = true;
    api.incidentDetail(selId)
      .then((d) => { if (on) { setDetail(d); setNote(d.note ?? ""); setToast(null); } })
      .catch((e: Error) => { if (on) setToast(e.message); });
    return () => { on = false; };
  }, [selId]);

  const patch = (body: { status?: string; note?: string }) => {
    if (selId === null) return;
    api.patchIncident(selId, body)
      .then((d) => { setDetail(d); setNote(d.note ?? ""); setToast(body.status ? `statut « ${STATUS_LABEL[body.status]} » enregistré` : "note enregistrée"); })
      .catch((e: Error) => setToast(e.message));
  };

  return (
    <>
      <Card title="Alertes réelles">
        {live.liveIncidents.length > 0 ? (
          <div className="card" style={{ marginBottom: 8 }}>
            <h3>arrivées en direct ({live.liveIncidents.length})</h3>
            <table>
              <tbody>
                {live.liveIncidents.slice(0, 6).map((li, i) => (
                  <tr key={`${li.id}:${i}`} onClick={() => { location.hash = `#/alerts/${li.id}`; }}>
                    <td><KindChip kind={li.kind} /></td>
                    <td><Sev sev={li.severity} /></td>
                    <td>{li.name ?? "-"} → {li.victim_name ?? "-"}</td>
                    <td className="muted">{coordText(li.x, li.y, li.z)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={live.clearUnread}>marquer comme lu ({live.unread})</button>
          </div>
        ) : null}

        <div className="flexrow">
          <label>nature</label>
          <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(0); }}>
            {KINDS.map((k) => (
              <option key={k} value={k}>{k === "" ? "toutes" : KIND_LABEL[k] ?? k}</option>
            ))}
          </select>

          <label>statut</label>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s === "" ? "tous" : STATUS_LABEL[s]}</option>
            ))}
          </select>

          <label>sévérité minimale</label>
          <input style={{ width: 60 }} value={minSev} onChange={(e) => { setMinSev(e.target.value); setPage(0); }} />
          <a href={csvUrl(kind)} className="primary" style={{ marginLeft: "auto" }}>exporter en CSV</a>
        </div>

        {toast ? (
          <>
            <Toast text={toast} />
            <button type="button" onClick={() => setToast(null)}>masquer ce message</button>
          </>
        ) : null}

        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>créé le</th><th>nature</th><th>sévérité</th><th>acteur</th><th>victime</th><th>position</th><th className="right">quantité</th><th>statut</th></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} onClick={() => { location.hash = `#/alerts/${i.id}`; }}>
                <td>{fmtDate(i.created_at)}</td>
                <td><KindChip kind={i.kind} /></td>
                <td><Sev sev={i.severity} /></td>
                <td>{i.actor ?? "-"}</td>
                <td>{i.victim ?? "-"}</td>
                <td className="muted">{coordText(i.x, i.y, i.z)} {i.world ? `· ${i.world}` : ""}</td>
                <td className="right">{fmtNum(i.amount)}</td>
                <td><StatusChip status={i.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flexrow" style={{ marginTop: 8 }}>
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← précédent</button>
          <span className="muted">{fmtNum(items.length)} sur {fmtNum(total)} incidents réels (les simulations sont masquées)</span>
          <button type="button" disabled={items.length < PAGE} onClick={() => setPage((p) => p + 1)}>suivant →</button>
        </div>
      </Card>

      {detail ? <IncidentDetail detail={detail} note={note} setNote={setNote} patch={patch} /> : null}
    </>
  );
}

function IncidentDetail({ detail, note, setNote, patch }: {
  detail: FullIncident;
  note: string;
  setNote: (v: string) => void;
  patch: (body: { status?: string; note?: string }) => void;
}) {
  const ev = detail.evidence ?? {};
  const scalars = Object.entries(ev).filter(([, v]) => isScalar(v));
  const composites = Object.entries(ev).filter(([, v]) => !isScalar(v));

  return (
    <>
      <div className="grid cols-2">
        <Card title={`Incident n° ${detail.id} · ${KIND_LABEL[detail.kind] ?? detail.kind}`}>
          {detail.test === 1 ? <p className="muted">issu d'une simulation de validation (masqué des alertes)</p> : null}
          <div className="kv"><span className="k">sévérité</span><b><Sev sev={detail.severity} /></b></div>
          <div className="kv"><span className="k">statut</span><b><StatusChip status={detail.status} /></b></div>
          <div className="kv"><span className="k">créé le</span><b>{fmtDate(detail.created_at)}</b></div>
          <div className="kv"><span className="k">acteur</span><b>{detail.actor_name ? <a href={`#/players/${detail.uid}`}>{detail.actor_name}</a> : "-"}</b></div>
          <div className="kv"><span className="k">victime</span><b>{detail.victim_name ? <a href={`#/players/${detail.victim_uid}`}>{detail.victim_name}</a> : "-"}</b></div>
          <div className="kv"><span className="k">monde</span><b>{detail.world_name ?? detail.wid ?? "-"}</b></div>
          <div className="kv">
            <span className="k">position</span>
            <b>
              {coordText(detail.x, detail.y, detail.z)}
              {" "}
              {detail.x !== null ? <a href={`#/map?wid=${detail.wid ?? 1}&x=${Math.round(detail.x)}&z=${Math.round(detail.z ?? 0)}`}>voir sur la carte</a> : null}
              {" "}
              {detail.x !== null ? <a href={`#/squaremap?wid=${detail.wid ?? 1}&x=${Math.round(detail.x)}&z=${Math.round(detail.z ?? 0)}`}>voir sur SquareMap</a> : null}
            </b>
          </div>
          <div className="kv"><span className="k">conteneur</span><b>{detail.container_key ?? "-"}</b></div>
          <div className="kv"><span className="k">quantité</span><b>{fmtNum(detail.amount)}</b></div>
          <div className="kv"><span className="k">fenêtre</span><b>{fmtDate(detail.window_start)} → {fmtDate(detail.window_end)}</b></div>

          <h3>Suivi administrateur</h3>
          <div className="flexrow">
            <button type="button" onClick={() => patch({ status: "new" })}>nouvel</button>
            <button type="button" onClick={() => patch({ status: "seen" })}>vu</button>
            <button type="button" onClick={() => patch({ status: "closed" })}>fermé</button>
            <span className="muted">jeton d'administration défini dans l'onglet Réglages, enregistré localement</span>
          </div>
          <label>note interne</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="note interne sur cet incident…" />
          <button className="primary" onClick={() => patch({ note })}>enregistrer la note</button>
        </Card>

        <Card title="Preuve décodée">
          {scalars.map(([k, v]) => (
            <div className="kv" key={k}>
              <span className="k">{EV_LABELS[k] ?? k}</span>
              <b>{typeof v === "string" ? v : fmtNum(Number(v))}</b>
            </div>
          ))}

          {composites.map(([k, v]) => (
            <div key={k}>
              <h3>{EV_LABELS[k] ?? k}</h3>
              {k === "terms" ? (
                Object.entries(v as Record<string, unknown>).map(([tk, tv]) => (
                  <div className="kv" key={tk}>
                    <span className="k">{TERM_LABELS[tk] ?? tk}</span>
                    <b>{fmtNum(Number(tv))}</b>
                  </div>
                ))
              ) : (
                <pre className="json">{JSON.stringify(v, null, 2)}</pre>
              )}
            </div>
          ))}

          {Object.keys(ev).length === 0 ? <p className="muted">preuve vide</p> : null}
        </Card>
      </div>

    </>
  );
}
