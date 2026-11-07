/** Détecteur de vol : retrait d'un conteneur attribué à un autre joueur. */
import { db, getSetting } from "../db.js";
import { homeOfPoint } from "./houses.js";
import { eventKey, getCursor, setCursor, insertIncident, checkIncidentArgs, THEFT_COLS } from "./cursor.js";

interface Th { [k: string]: number }
interface Wt { [k: string]: number }

function th(): Th { return getSetting("thresholds_json", {} as Th); }
function wts(): Wt { return getSetting("weights_json", {} as Wt); }
function depLabels() {
  return getSetting("container_action_json", { deposit: 0, withdraw: 1 } as Record<string, number>);
}

/** Bonus de rareté par matériau (paliers simples, recalculés depuis material). */
export function refreshItemRarity(): void {
  db.exec("DELETE FROM item_rarity");
  const tiers: [string[], number][] = [
    [["minecraft:netherite_scrap", "minecraft:netherite_ingot", "minecraft:netherite_sword", "minecraft:netherite_pickaxe",
      "minecraft:netherite_chestplate", "minecraft:ancient_debris", "minecraft:spawner", "minecraft:beacon", "minecraft:nether_star"], 15],
    [["minecraft:diamond", "minecraft:diamond_sword", "minecraft:diamond_pickaxe", "minecraft:diamond_axe",
      "minecraft:diamond_helmet", "minecraft:diamond_chestplate", "minecraft:diamond_leggings", "minecraft:diamond_boots",
      "minecraft:enchanted_book", "minecraft:shulker_box", "minecraft:ender_pearl"], 12],
    [["minecraft:gold_ingot", "minecraft:emerald", "minecraft:iron_block", "minecraft:amethyst", "minecraft:copper_block",
      "minecraft:lapis_block", "minecraft:redstone_block"], 6],
  ];
  for (const [names, bonus] of tiers) {
    const list = names.map((n) => `'${n}'`).join(",");
    db.exec(`INSERT OR IGNORE INTO item_rarity(id,bonus) SELECT id, ${bonus} FROM material WHERE name IN (${list})`);
  }
}

interface WithdrawEvent {
  rowid: number; time: number; uid: number; wid: number; x: number; y: number; z: number;
  item_id: number; amount: number; phys_key: string; test: number;
}

interface Salvo {
  phys_key: string;
  uid: number;
  start: number;
  end: number;
  events: WithdrawEvent[];
  total_amount: number;
  rarity: number;
  top_items: { item_id: number; name: string; amount: number }[];
}

function makeSalvo(evts: WithdrawEvent[]): Salvo {
  const perItem = new Map<number, number>();
  for (const e of evts) perItem.set(e.item_id, (perItem.get(e.item_id) ?? 0) + e.amount);
  const nameOf = db.prepare("SELECT COALESCE(name, CAST(? AS TEXT)) n FROM material WHERE id=?");
  const top = [...perItem.entries()]
    .map(([item_id, amount]) => ({ item_id, amount, name: (nameOf.get(item_id, item_id) as { n: string }).n }))
    .sort((a, b) => b.amount - a.amount);
  const ids = evts.map((e) => e.item_id).join(",");
  const rarity = (db.prepare(`SELECT COALESCE(MAX(bonus),0) b FROM item_rarity WHERE id IN (${ids})`).get() as { b: number }).b;
  return {
    phys_key: evts[0].phys_key,
    uid: evts[0].uid,
    start: evts[0].time,
    end: evts[evts.length - 1].time,
    events: evts,
    total_amount: evts.reduce((s, e) => s + e.amount, 0),
    rarity,
    top_items: top.slice(0, 8),
  };
}

/** Regroupe les retraits en salves (même conteneur, même joueur, intervalle < salvage_window). */
function buildSalvos(events: WithdrawEvent[]): Salvo[] {
  const win = th().salvage_window_sec ?? 60;
  const byKey = new Map<string, WithdrawEvent[]>();
  for (const e of events) {
    const k = `${e.phys_key}|${e.uid}`;
    const arr = byKey.get(k) ?? [];
    arr.push(e);
    byKey.set(k, arr);
  }
  const salvos: Salvo[] = [];
  for (const arr of byKey.values()) {
    arr.sort((a, b) => a.time - b.time || a.rowid - b.rowid);
    let cur: WithdrawEvent[] = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].time - cur[cur.length - 1].time <= win) cur.push(arr[i]);
      else {
        salvos.push(makeSalvo(cur));
        cur = [arr[i]];
      }
    }
    salvos.push(makeSalvo(cur));
  }
  return salvos;
}

/** Session ouverte au moment de l'événement ? */
export function sessionOpen(uid: number, time: number): boolean {
  const last = db.prepare("SELECT action FROM session_evt WHERE uid=? AND time<=? ORDER BY time DESC, rowid DESC LIMIT 1").get(uid, time) as { action: number } | undefined;
  return last?.action === 0; // login sans logout intermédiaire
}

/** Le joueur a-t-il déjà posé des blocs près de cette position avant l'événement ? */
export function builtNear(uid: number, wid: number, x: number, z: number, before: number, radius: number): boolean {
  const r = db.prepare(
    `SELECT COUNT(*) n FROM blk WHERE uid=? AND wid=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?
       AND action=0 AND time < ?`
  ).get(uid, wid, x - radius, x + radius, z - radius, z + radius, before) as { n: number };
  return r.n > 0;
}

/** L'acteur a-t-il déposé des objets dans SES propres conteneurs juste après (recel) ? */
function transferCorrelation(uid: number, end: number): object | null {
  const DEP = depLabels().deposit ?? 0;
  const rows = db.prepare(
    `SELECT e.time,e.x,e.y,e.z,e.amount,m.name FROM container_evt e
     JOIN container_owner o ON o.key=e.phys_key AND o.trust_state='owned' AND o.owner_uid=?
     LEFT JOIN material m ON m.id=e.item_id
     WHERE e.uid=? AND e.action=${DEP} AND e.time BETWEEN ? AND ?`
  ).all(uid, uid, end - 30, end + 300) as { time: number; x: number; y: number; z: number; amount: number; name: string }[];
  return rows.length ? { deposited_to_own_containers: rows.slice(0, 6) } : null;
}

export function chatNear(uid: number, t0: number, t1: number): object[] {
  const sec = th().chat_correlation_sec ?? 90;
  const chats = db.prepare("SELECT time,msg,x,z FROM chat_evt WHERE uid=? AND time BETWEEN ? AND ? ORDER BY time LIMIT 6")
    .all(uid, t0 - sec, t1 + sec) as { time: number; msg: string; x: number; z: number }[];
  const cmds = db.prepare("SELECT time,cmd,x,z FROM command_evt WHERE uid=? AND time BETWEEN ? AND ? ORDER BY time LIMIT 6")
    .all(uid, t0 - sec, t1 + sec) as { time: number; cmd: string; x: number; z: number }[];
  const out: { kind: string; time: number; text: string; x: number; z: number }[] = [
    ...chats.map((r) => ({ kind: "chat", time: r.time, text: r.msg, x: r.x, z: r.z })),
    ...cmds.map((r) => ({ kind: "command", time: r.time, text: r.cmd, x: r.x, z: r.z })),
  ];
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Crée les incidents de vol. Renvoie le nombre d'incidents insérés et le détail des exclusions. */
export function detectTheft(scanFromRowid: number): { created: number; eventsScanned: number; skipped: Record<string, number> } {
  const WDR = depLabels().withdraw ?? 1;
  const evs = db.prepare(
    `SELECT rowid,time,uid,wid,x,y,z,item_id,amount,phys_key,test
     FROM container_evt
     WHERE rowid > ? AND action=${WDR} AND rolled_back=0 AND uid NOT NULL AND phys_key NOT NULL
     ORDER BY time, rowid`
  ).all(scanFromRowid) as WithdrawEvent[];

  const owners = db.prepare("SELECT owner_uid,trust_state,locked FROM container_owner WHERE key=?");
  const shareOf = db.prepare(
    "SELECT co_owner,score,share,events,dep_vol,wdr_vol,name FROM container_share cs JOIN player p ON p.uid=cs.uid WHERE cs.key=? AND cs.uid=?"
  );
  const whitelist = db.prepare("SELECT is_whitelisted FROM player WHERE uid=?");
  const skipped: Record<string, number> = { fake_user: 0, unowned_container: 0, self_container: 0, whitelisted: 0 };

  // Deux flux : les retraits "classiques" (conteneur owned ou shared, acteur non membre) et
  // les retraits des copropriétaires d'un conteneur partagé, évalués par le déséquilibre du flux.
  const classicEvts: WithdrawEvent[] = [];
  const memberEvts: WithdrawEvent[] = [];

  for (const e of evs) {
    const fake = (db.prepare("SELECT is_fake FROM player WHERE uid=?").get(e.uid) as { is_fake: number } | undefined)?.is_fake ?? 0;
    if (fake) { skipped.fake_user++; continue; }
    const o = owners.get(e.phys_key) as { owner_uid: number; trust_state: string } | undefined;
    if (!o || (o.trust_state !== "owned" && o.trust_state !== "shared")) { skipped.unowned_container++; continue; }   // règle anti-faux-positif

    if (o.trust_state === "shared") {
      const cs = shareOf.get(e.phys_key, e.uid) as { co_owner: number } | undefined;
      if (cs?.co_owner === 1) {
        if ((whitelist.get(e.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) { skipped.whitelisted++; continue; }
        memberEvts.push(e); // copropriétaire : on jugera le flux net du conteneur, pas l'événement isolé.
        continue;
      }
    }

    if (o.owner_uid === e.uid) { skipped.self_container++; continue; }
    if ((whitelist.get(e.uid) as { is_whitelisted: number } | undefined)?.is_whitelisted) { skipped.whitelisted++; continue; }
    classicEvts.push(e);
  }

  const salvos = buildSalvos(classicEvts);
  const w = wts();
  const t = th();
  let created = 0;

  const insInc = insertIncident(THEFT_COLS);

  db.transaction(() => {
    for (const s of salvos) {
      const o = owners.get(s.phys_key) as { owner_uid: number };
      const base = w.base ?? 40;
      const amountPart = Math.min(w.amount_max ?? 30, (s.total_amount / 64) * 10);
      const first = s.events[0];

      // Position réelle du conteneur (le log stocke la position du joueur au moment du clic).
      const cparts = s.phys_key.replace(/^orph:/, "").split("|").map(Number);
      const cwid = cparts[0], cx = cparts[1], cy = cparts[2], cz = cparts[3];

      const home = homeOfPoint(cwid, cx, cz);
      const houseBonus = home && home.uid === o.owner_uid && home.uid !== s.uid ? w.house_bonus ?? 20 : 0;
      const stranger = builtNear(s.uid, cwid, cx, cz, s.start, t.stranger_radius ?? 32) ? 0 : w.stranger_bonus ?? 15;
      const sessBonus = sessionOpen(s.uid, s.end) ? w.session_bonus ?? 10 : 0;
      const severity = Math.round((base + amountPart + (s.rarity ?? 0) + houseBonus + stranger + sessBonus) * 10) / 10;

      const evidence = {
        container: s.phys_key,
        owner_uid: o.owner_uid,
        owner_name: (db.prepare("SELECT name FROM player WHERE uid=?").get(o.owner_uid) as { name: string } | undefined)?.name,
        items: s.top_items,
        total_amount: s.total_amount,
        events: s.events.length,
        event_rowids: s.events.map((e) => e.rowid),
        terms: { base, amount_part: +amountPart.toFixed(2), rarity_bonus: s.rarity ?? 0, house_bonus: houseBonus, stranger_bonus: stranger, session_bonus: sessBonus },
        home_of_container: home ? { uid: home.uid, id: home.id } : null,
        transfer: transferCorrelation(s.uid, s.end),
        chat_commands: chatNear(s.uid, s.start, s.end),
      };

      const vals = [
        "theft", severity, s.uid, first.wid, first.x, first.y, first.z, o.owner_uid, s.phys_key,
        first.item_id, s.total_amount, s.start, s.end, JSON.stringify(evidence),
        "new", Math.floor(Date.now() / 1000), eventKey("container_evt", s.events[0].rowid),
      ];
      checkIncidentArgs(THEFT_COLS, vals);
      const r = insInc.run(vals);
      if (r.changes > 0) created++;
    }

    // Vol par un copropriétaire : retraits >> dépôts sur le conteneur partagé.
    const ratio = t.member_wdr_ratio ?? 3.0;
    const minVol = t.member_min_volume ?? 64;
    for (const s of pairGroups(memberEvts)) {
      const cs = shareOf.get(s.phys_key, s.uid) as
        | { co_owner: number; score: number; share: number; events: number; dep_vol: number; wdr_vol: number, name: string } | undefined;
      if (!cs || cs.wdr_vol < minVol) continue;
      const r = cs.dep_vol > 0 ? cs.wdr_vol / cs.dep_vol : Infinity;
      if (r < ratio) continue; // un co-détecteur de flux : le membre doit sortir nettement plus qu'il ne dépose.

      const base = w.member_base ?? 35;
      const netflowPart = Math.min(w.member_netflow_max ?? 25, ((r - ratio) / ratio) * 10 + (s.total_amount / 64) * 5);
      const severity = Math.round((base + netflowPart + (s.rarity ?? 0)) * 10) / 10;

      const o = owners.get(s.phys_key) as { owner_uid: number };
      const evidence = {
        container: s.phys_key,
        shared_container: true,
        member_uid: s.uid,
        member_name: cs.name,
        primary_owner_uid: o.owner_uid,
        dep_vol: cs.dep_vol,
        wdr_vol: cs.wdr_vol,
        ratio: r === Infinity ? null : +r.toFixed(2),
        share: cs.share,
        items: s.top_items,
        total_amount: s.total_amount,
        events: s.events.length,
        event_rowids: s.events.map((e) => e.rowid),
        terms: { base, netflow_part: +netflowPart.toFixed(2), rarity_bonus: s.rarity ?? 0, wdr_dep_ratio: ratio, min_volume: minVol },
        chat_commands: chatNear(s.uid, s.start, s.end),
      };

      const first = s.events[0];
      const vals = [
        "theft_shared", severity, s.uid, first.wid, first.x, first.y, first.z, o.owner_uid, s.phys_key,
        first.item_id, s.total_amount, s.start, s.end, JSON.stringify(evidence),
        "new", Math.floor(Date.now() / 1000), eventKey("container_evt", first.rowid),
      ];
      checkIncidentArgs(THEFT_COLS, vals);
      const r2 = insInc.run(vals);
      if (r2.changes > 0) created++;
    }
  })();

  return { created, eventsScanned: evs.length, skipped };
}

/** Regroupe tous les retraits d'un même copropriétaire sur un même conteneur (une seule règle de flux). */
function pairGroups(events: WithdrawEvent[]): Salvo[] {
  const byPair = new Map<string, WithdrawEvent[]>();
  for (const e of events) {
    const k = `${e.phys_key}|${e.uid}`;
    const arr = byPair.get(k) ?? [];
    arr.push(e);
    byPair.set(k, arr);
  }
  const out: Salvo[] = [];
  for (const arr of byPair.values()) {
    arr.sort((a, b) => a.time - b.time || a.rowid - b.rowid);
    out.push(makeSalvo(arr));
  }
  return out;
}

export function theftScanCursor(): number {
  // Repart un peu en arrière pour attraper les salves à cheval sur deux cycles.
  return getCursor("theft_scan_rowid", 500);
}

export function setTheftScanCursor(rowid: number): void {
  setCursor("theft_scan_rowid", rowid);
}
