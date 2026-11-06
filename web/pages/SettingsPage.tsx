/** Réglages : poids et seuils des détecteurs, whitelist, propos surveillés, Discord, jeton d'administration. */
import { useEffect, useState } from "react";
import { api, getAdminToken, setAdminToken } from "../api.js";
import { lastCycleLabel, useLive } from "../live.js";
import { Card, Toast } from "../ui.js";

const WEIGHT_LABELS: Record<string, string> = {
  base: "vol : base",
  amount_max: "vol : plafond quantité",
  house_bonus: "bonus conteneur dans une maison",
  stranger_bonus: "bonus joueur inconnu sur zone",
  session_bonus: "bonus session ouverte",
  grief_base: "grief : base",
  tnt_base: "TNT : base",
  churn_base: "churn : base",
  chat_base: "propos : base",
  command_base: "commande : base",
  chat_hit_max: "plafond bonus mots surveillés",
  theft_w: "poids vol dans le score",
  grief_w: "poids grief dans le score",
  anomaly_w: "poids anomalie dans le score",
  chat_w: "poids propos dans le score",
  placed: "score : poids blocs posés",
  usage: "score : poids usage partagé",
  proximity: "score : poids proximité",
  netflow: "score : poids flux net",
  exclusive: "score : poids exclusivité",
};

const THRESHOLD_LABELS: Record<string, string> = {
  home_min_blocks: "maison : blocs minimum",
  home_min_types: "maison : types fonctionnels minimum",
  territory_chunks: "territoire : emprise (chunks)",
  owned_min_score: "possédé : score minimum",
  public_max_score: "public : score maximum",
  min_events_for_owner: "événements minimum pour un propriétaire",
  theft_alert_severity: "vol : sévérité d'alerte",
  discord_min_severity: "Discord : sévérité minimale",
  composite_alert: "score quotidien : seuil de fusion",
  salvage_window_sec: "salvo : fenêtre (secondes)",
  proximity_blocks: "proximité : blocs pour le score",
  stranger_radius: "inconnu : rayon de construction (blocs)",
  chat_correlation_sec: "corrélation des propos (secondes)",
  container_match_radius: "appariement conteneur : rayon (blocs)",
  grief_min_blocks: "grief : blocs cassés minimum",
  grief_window_sec: "grief : fenêtre (secondes)",
  tnt_min_blocks: "TNT : poses minimum",
  churn_min_logins: "churn : connexions minimum",
  churn_window_sec: "churn : fenêtre (secondes)",
  churn_max_placed: "churn : blocs posés maximum",
};

/** Fusion des clés connues et des clés supplémentaires du fichier de réglages. */
function merge(src: Record<string, unknown>, labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(labels)) out[k] = src[k] === undefined ? "" : String(src[k]);
  for (const k of Object.keys(src).sort()) if (!(k in out)) out[k] = String(src[k]);
  return out;
}

function numeric(m: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(m)) {
    const s = m[k].trim();
    if (s !== "") {
      const n = Number(s);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

export default function SettingsPage() {
  const live = useLive();
  const [w, setW] = useState<Record<string, string>>({});
  const [t, setT] = useState<Record<string, string>>({});
  const [wl, setWl] = useState<string[]>([]);
  const [kw, setKw] = useState("keywords\ncommands");
  const [cmd, setCmd] = useState("");
  const [url, setUrl] = useState("");
  const [minSev, setMinSev] = useState("60");
  const [user, setUser] = useState("coreprotect-watcher");
  const [excluded, setExcluded] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [token, setTokenState] = useState(getAdminToken());
  const [newName, setNewName] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => {
      const st = s.settings;
      setW(merge((st.weights_json as Record<string, unknown>) ?? {}, WEIGHT_LABELS));
      setT(merge((st.thresholds_json as Record<string, unknown>) ?? {}, THRESHOLD_LABELS));
      setWl(((st.whitelist_json as string[]) ?? []).map(String));
      const cw = (st.chat_watch_json as { keywords?: string[]; commands?: string[] }) ?? {};
      setKw((cw.keywords ?? []).join("\n"));
      setCmd((cw.commands ?? []).join("\n"));
      const dj = (st.discord_json as { url?: string; min_severity?: number; username?: string }) ?? {};
      setUrl(dj.url ?? "");
      setMinSev(String(dj.min_severity ?? 60));
      setUser(dj.username ?? "coreprotect-watcher");
      setExcluded(((st.excluded_worlds_json as number[]) ?? []).join(", "));
      const bl = (st.block_action_labels_json as Record<string, string>) ?? {};
      setLabels(bl);
    }).catch((e: Error) => setToast(e.message));
  }, []);

  const save = () => {
    const body = {
      weights_json: numeric(w),
      thresholds_json: numeric(t),
      whitelist_json: wl,
      chat_watch_json: { keywords: kw.split("\n").map((x) => x.trim()).filter(Boolean), commands: cmd.split("\n").map((x) => x.trim()).filter(Boolean) },
      discord_json: { url: url.trim(), min_severity: Number(minSev) || 60, username: user.trim() || "coreprotect-watcher" },
      excluded_worlds_json: excluded.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n)),
    };
    api.saveSettings(body)
      .then((r) => setToast(`réglages enregistrés (${r.changed.length} clé(s)) : recalcul complet demandé au prochain cycle`))
      .catch((e: Error) => setToast(e.message));
  };

  const forceCycle = () => {
    api.cycleRun().then(() => setToast("cycle forcé demandé")).catch((e: Error) => setToast(e.message));
  };

  return (
    <>
      <div className="flexrow" style={{ marginBottom: 8 }}>
        <span className="muted">direct : {live.connected ? "connecté" : "hors ligne"} · dernier cycle : {lastCycleLabel(live.lastCycleAt)}</span>
        <button type="button" onClick={forceCycle}>forcer un cycle complet</button>
      </div>

      {toast ? (
        <>
          <Toast text={toast} />
          <button type="button" onClick={() => setToast(null)}>masquer ce message</button>
        </>
      ) : null}

      <div className="grid cols-2">
        <Card title="Poids des détecteurs et de la propriété (weights_json)">
          {Object.entries(w).map(([k, v]) => (
            <div className="flexrow" key={k}>
              <label>{WEIGHT_LABELS[k] ?? k}</label>
              <input style={{ width: 120 }} value={v} onChange={(e) => setW({ ...w, [k]: e.target.value })} />
            </div>
          ))}
        </Card>

        <Card title="Seuils (thresholds_json)">
          {Object.entries(t).map(([k, v]) => (
            <div className="flexrow" key={k}>
              <label>{THRESHOLD_LABELS[k] ?? k}</label>
              <input style={{ width: 120 }} value={v} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
            </div>
          ))}
        </Card>

        <Card title="Whitelist (exonération un sens)">
          <p className="muted">Les actions des joueurs listés n'émettent aucune alerte ; leurs conteneurs restent propriété suivie et les vols d'autrui sur ces conteneurs sont signalés.</p>
          {wl.map((n) => (
            <span key={n} className="chip owned" style={{ marginRight: 6 }}>
              {n}
              {" "}
              <button type="button" onClick={() => setWl(wl.filter((x) => x !== n))}>retirer</button>
            </span>
          ))}
          <div className="flexrow">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="nom du joueur" />
            <button type="button" onClick={() => { const n = newName.trim(); if (n && !wl.includes(n)) { setWl([...wl, n]); setNewName(""); } }}>ajouter à la whitelist</button>
          </div>
        </Card>

        <Card title="Propos et commandes surveillés">
          <label>mots-clés de chat (un par ligne)</label>
          <textarea value={kw} onChange={(e) => setKw(e.target.value)} />
          <label>préfixes de commande (un par ligne, sans slash)</label>
          <textarea value={cmd} onChange={(e) => setCmd(e.target.value)} />
        </Card>

        <Card title="Notification Discord">
          <label>URL du webhook (vide = désactivée)</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" />
          <label>sévérité minimale d'envoi</label>
          <input style={{ width: 120 }} value={minSev} onChange={(e) => setMinSev(e.target.value)} />
          <label>nom de l'auteur du message</label>
          <input style={{ width: 200 }} value={user} onChange={(e) => setUser(e.target.value)} />
        </Card>

        <Card title="Jeton d'administration">
          <p className="muted">Le jeton est enregistré dans ce navigateur, utilisé pour les écritures (statut des incidents, réglages, cycle forcé).</p>
          <label>jeton d'administration</label>
          <input value={token} onChange={(e) => { setTokenState(e.target.value); setAdminToken(e.target.value); }} />
        </Card>

        <Card title="Libellés des actions de blocs (lecture seule)">
          <p className="muted">codes : 0 pose, 1 casse, 2 interaction, 3 autre</p>
          {Object.entries(labels).map(([k, v]) => (
            <div className="kv" key={k}><span className="k">{k}</span><b>{v}</b></div>
          ))}
        </Card>

        <Card title="Mondes exclus de l'ingestion">
          <label>wid séparés par virgule</label>
          <input value={excluded} onChange={(e) => setExcluded(e.target.value)} placeholder="2, 3" />
        </Card>
      </div>

      <div className="flexrow" style={{ marginTop: 8 }}>
        <button className="primary" onClick={save}>enregistrer les réglages</button>
        <span className="muted">l'enregistrement déclenche un recalcul complet au prochain cycle</span>
      </div>

    </>
  );
}
