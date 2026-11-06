/** Détecteur de chat et de commandes : mots clefs et commandes surveillées (réglages). */
import { db, getSetting } from "../db.js";
import { eventKey, insertIncident, checkIncidentArgs, CHAT_COLS } from "./cursor.js";

interface Th { [k: string]: number }
interface Wt { [k: string]: number }

function th(): Th { return getSetting("thresholds_json", {} as Th); }
function wts(): Wt { return getSetting("weights_json", {} as Wt); }

interface Watch { keywords: string[]; commands: string[] }

function watch(): Watch {
  const w = getSetting<Record<string, unknown>>("chat_watch_json", {}) as Partial<Watch>;
  return { keywords: w.keywords ?? [], commands: w.commands ?? [] };
}

const fakeStmt = db.prepare("SELECT is_fake FROM player WHERE uid=?");
const whiteStmt = db.prepare("SELECT is_whitelisted FROM player WHERE uid=?");

/** Messages de chat contenant un mot clef surveillé. */
export function detectChat(scanFromRowid: number): { created: number; eventsScanned: number; skipped: Record<string, number> } {
  const rows = db.prepare(
    "SELECT rowid,time,uid,wid,x,y,z,msg FROM chat_evt WHERE rowid > ? AND uid NOT NULL ORDER BY time, rowid"
  ).all(scanFromRowid) as { rowid: number; time: number; uid: number; wid: number | null; x: number | null; y: number | null; z: number | null; msg: string }[];

  const kws = watch().keywords.map((k) => k.toLowerCase());
  const w = wts();
  const skipped: Record<string, number> = { fake_user: 0, whitelisted: 0, no_keyword: 0 };

  const insInc = insertIncident(CHAT_COLS);

  let created = 0;
  for (const r of rows) {
    if ((fakeStmt.get(r.uid) as { is_fake: number } | undefined)?.is_fake ?? 1) { skipped.fake_user++; continue; }
    if ((whiteStmt.get(r.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) { skipped.whitelisted++; continue; }

    const msg = (r.msg ?? "").toLowerCase();
    const hits = kws.filter((k) => k && msg.includes(k));
    if (!hits.length) { skipped.no_keyword++; continue; }

    const base = w.chat_base ?? 20;
    const hitPart = Math.min(w.chat_hit_max ?? 15, hits.length * 8);
    const severity = Math.round((base + hitPart) * 10) / 10;

    const evidence = {
      message: r.msg,
      keywords: hits,
      window_sec: th().chat_correlation_sec ?? 90,
      terms: { base, keyword_part: hitPart },
    };

    const valsChat: unknown[] = [
      "chat", severity, r.uid, r.wid, r.x, r.y, r.z, r.time, r.time, JSON.stringify(evidence),
      "new", Math.floor(Date.now() / 1000), eventKey("chat_evt", r.rowid),
    ];
    checkIncidentArgs(CHAT_COLS, valsChat);
    const res = insInc.run(valsChat);
    if (res.changes > 0) created++;
  }

  return { created, eventsScanned: rows.length, skipped };
}

/** Commandes dont le préfixe est surveillé (/give, /gamemode…). */
export function detectCommands(scanFromRowid: number): { created: number; eventsScanned: number; skipped: Record<string, number> } {
  const rows = db.prepare(
    "SELECT rowid,time,uid,wid,x,y,z,cmd FROM command_evt WHERE rowid > ? AND uid NOT NULL ORDER BY time, rowid"
  ).all(scanFromRowid) as { rowid: number; time: number; uid: number; wid: number | null; x: number | null; y: number | null; z: number | null; cmd: string }[];

  const prefixes = watch().commands.map((c) => c.toLowerCase());
  const w = wts();
  const skipped: Record<string, number> = { fake_user: 0, whitelisted: 0, no_match: 0 };

  const insInc = insertIncident(CHAT_COLS);

  let created = 0;
  for (const r of rows) {
    if ((fakeStmt.get(r.uid) as { is_fake: number } | undefined)?.is_fake ?? 1) { skipped.fake_user++; continue; }
    if ((whiteStmt.get(r.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) { skipped.whitelisted++; continue; }

    const cmd = (r.cmd ?? "").toLowerCase();
    const hit = prefixes.find((p) => p && cmd.startsWith(p));
    if (!hit) { skipped.no_match++; continue; }

    const base = w.command_base ?? 40;
    const severity = Math.round(base * 10) / 10;

    const evidence = {
      command: r.cmd,
      prefix: hit,
      terms: { base },
    };

    const valsCmd: unknown[] = [
      "chat", severity, r.uid, r.wid, r.x, r.y, r.z, r.time, r.time, JSON.stringify(evidence),
      "new", Math.floor(Date.now() / 1000), eventKey("command_evt", r.rowid),
    ];
    checkIncidentArgs(CHAT_COLS, valsCmd);
    const res = insInc.run(valsCmd);
    if (res.changes > 0) created++;
  }

  return { created, eventsScanned: rows.length, skipped };
}
