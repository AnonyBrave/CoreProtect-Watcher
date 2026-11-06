/** Propriété inférée des conteneurs physiques : appariement bloc posé <-> événements, score d'owner. */
import { db, getSetting } from "../db.js";
import { distanceToHome } from "./houses.js";

const SEP = "|";

export function physKey(wid: number, x: number, y: number, z: number): string {
  return `${wid}|${x}|${y}|${z}`;
}

interface Th { [k: string]: number }

function th(): Th {
  return getSetting("thresholds_json", {} as Th);
}
function wts(): Th {
  const w = getSetting("weights_json", {} as Th);
  return {
    placed: w.placed ?? 0.5,
    usage: w.usage ?? 0.2,
    proximity: w.proximity ?? 0.15,
    netflow: w.netflow ?? 0.15,
    exclusive: w.exclusive ?? 0.45,
  } as Th;
}

/** Construit la liste des conteneurs physiques à partir des blocs posés (co chest/barrel). */
export function buildPhysContainers(sinceRowid?: number): number {
  const rows = db
    .prepare(
      `SELECT wid,x,y,z,type_id FROM blk WHERE rowid > ? AND type_id IN (SELECT id FROM container_type) GROUP BY wid,x,y,z`
    )
    .all(sinceRowid ?? 0) as { wid: number; x: number; y: number; z: number; type_id: number }[];
  const ins = db.prepare(
    `INSERT INTO phys_container(key,wid,x,y,z,type_id,orphan) VALUES(?,?,?,?,?,?,0)
     ON CONFLICT(key) DO UPDATE SET type_id=excluded.type_id`
  );
  db.transaction(() => {
    for (const r of rows) ins.run(physKey(r.wid, r.x, r.y, r.z), r.wid, r.x, r.y, r.z, r.type_id);
  })();

  // Posé par qui : dernière pose du bloc à cette coordonnée.
  db.prepare(
    `UPDATE phys_container SET placed_uid=(
        SELECT b.uid FROM blk b
        WHERE b.wid=phys_container.wid AND b.x=phys_container.x AND b.y=phys_container.y AND b.z=phys_container.z
          AND b.type_id IN (SELECT id FROM container_type) AND b.action=0
        ORDER BY b.time DESC, b.rowid DESC LIMIT 1) WHERE placed_uid IS NULL`
  ).run();
  db.prepare("UPDATE phys_container SET placed_uid=-1 WHERE placed_uid IS NULL").run();
  return rows.length;
}

/** Supprime les positions d'interaction devenues sans événement (après ré-appariement). */
export function dropEmptyOrphans(): void {
  db.prepare("DELETE FROM phys_container WHERE orphan=1 AND COALESCE(total_events,0)=0").run();
}

/** Associe chaque événement d'interaction à son conteneur physique (le log stocke la position du joueur). */
export function assignEventsToPhys(onlyUnmapped = true): number {
  const R = th().container_match_radius ?? 2;
  const findStmt = db.prepare(
    `SELECT key FROM phys_container p
     WHERE p.wid=@wid AND p.orphan=0 AND p.x BETWEEN @x-@R AND @x+@R AND p.z BETWEEN @z-@R AND @z+@R
       AND p.y BETWEEN @y-3 AND @y+1
     ORDER BY abs(p.x-@x)+abs(p.y-@y)+abs(p.z-@z) LIMIT 1`
  );
  const insOrphan = db.prepare(
    `INSERT INTO phys_container(key,wid,x,y,z,orphan,placed_uid) VALUES(@key,@wid,@x,@y,@z,1,-1)
     ON CONFLICT(key) DO NOTHING`
  );
  const setKey = db.prepare("UPDATE container_evt SET phys_key=@key WHERE rowid=@rowid");

  const evs = db
    .prepare(`SELECT rowid,wid,x,y,z FROM container_evt ${onlyUnmapped ? "WHERE phys_key IS NULL" : ""} ORDER BY rowid`)
    .all() as { rowid: number; wid: number; x: number; y: number; z: number }[];

  db.transaction(() => {
    for (const e of evs) {
      const hit = findStmt.get({ wid: e.wid, x: e.x, y: e.y, z: e.z, R }) as { key: string } | undefined;
      let key = hit?.key;
      if (!key) {
        key = `orph:${physKey(e.wid, e.x, e.y, e.z)}`;
        insOrphan.run({ key, wid: e.wid, x: e.x, y: e.y, z: e.z });
      }
      setKey.run({ key, rowid: e.rowid });
    }
  })();
  return evs.length;
}

/** Agrégats par conteneur physique + usage par joueur. */
export function rebuildAggregates(keys?: Set<string>): void {
  const dep = getSetting("container_action_json", { deposit: 0, withdraw: 1 } as Record<string, number>);
  const DEP = dep.deposit ?? 0;

  const targets = keys ? [...keys] : (db.prepare("SELECT key FROM phys_container").all() as { key: string }[]).map((r) => r.key);
  const aggStmt = db.prepare(
    `UPDATE phys_container SET
        total_events=(SELECT COUNT(*) FROM container_evt e WHERE e.phys_key=phys_container.key AND e.uid NOT NULL AND e.rolled_back=0),
        deposits=(SELECT COALESCE(SUM(e.action=${DEP}),0) FROM container_evt e WHERE e.phys_key=phys_container.key AND e.uid NOT NULL AND e.rolled_back=0),
        withdraws=(SELECT COALESCE(SUM(e.action!=${DEP}),0) FROM container_evt e WHERE e.phys_key=phys_container.key AND e.uid NOT NULL AND e.rolled_back=0),
        volume=(SELECT COALESCE(SUM(e.amount),0) FROM container_evt e WHERE e.phys_key=phys_container.key AND e.uid NOT NULL AND e.rolled_back=0),
        first_seen=(SELECT MIN(e.time) FROM container_evt e WHERE e.phys_key=phys_container.key),
        last_seen=(SELECT MAX(e.time) FROM container_evt e WHERE e.phys_key=phys_container.key)
     WHERE key=@key`
  );
  const usageDel = db.prepare("DELETE FROM usage_stat WHERE key=@key");
  const usageIns = db.prepare(
    `INSERT INTO usage_stat(key,uid,deposits,withdraws,events,volume,first_time,last_time)
     SELECT @key, e.uid, SUM(e.action=${DEP}), SUM(e.action!=${DEP}), COUNT(*), SUM(e.amount), MIN(e.time), MAX(e.time)
     FROM container_evt e JOIN player p ON p.uid=e.uid
     WHERE e.phys_key=@key AND e.rolled_back=0 AND p.is_fake=0
     GROUP BY e.uid`
  );

  db.transaction(() => {
    for (const key of targets) {
      aggStmt.run({ key });
      usageDel.run({ key });
      usageIns.run({ key });
    }
  })();
}

interface Usage { uid: number; deposits: number; withdraws: number; events: number; volume: number; name: string }

/** Score d'owner, avec verrouillage de la propriété établie (un retrait tiers ne l'efface pas). */
export function scoreContainer(key: string): { owner_uid: number | null; score: number; state: string; locked: boolean; evidence: object } {
  const pc = db.prepare("SELECT * FROM phys_container WHERE key=?").get(key) as
    | { key: string; wid: number; x: number; y: number; z: number; placed_uid: number; total_events: number; deposits: number; withdraws: number; volume: number; orphan: number }
    | undefined;
  const prev = db.prepare("SELECT owner_uid,score,trust_state,locked FROM container_owner WHERE key=?").get(key) as
    | { owner_uid: number; score: number; trust_state: string; locked: number }
    | undefined;

  if (!pc) return { owner_uid: null, score: 0, state: "untracked", locked: false, evidence: { reason: "conteneur inconnu" } };

  const t = th();
  const w = wts();
  const minEvents = t.min_events_for_owner ?? 3;

  const usages: Usage[] = db
    .prepare(
      `SELECT u.uid,u.deposits,u.withdraws,u.events,u.volume,p.name FROM usage_stat u JOIN player p ON p.uid=u.uid
       WHERE u.key=? AND p.is_fake=0`
    )
    .all(key) as Usage[];

  // Propriété déjà verrouillée et encore étayée -> on la conserve telle quelle.
  if (prev?.locked && prev.owner_uid > 0) {
    const own = usages.find((u) => u.uid === prev.owner_uid);
    const supported = pc.placed_uid === prev.owner_uid || (own && own.events >= minEvents);
    if (supported) {
      return {
        owner_uid: prev.owner_uid,
        score: prev.score,
        state: "owned",
        locked: true,
        evidence: {
          locked_at_first_evidence: true,
          placed_uid: pc.placed_uid,
          owner_events: own?.events ?? 0,
          foreign_users: usages.filter((u) => u.uid !== prev.owner_uid).map((u) => ({ uid: u.uid, name: u.name, events: u.events })),
        },
      };
    }
  }

  const cands = new Set<number>(usages.map((u) => u.uid));
  if (pc.placed_uid > 0) {
    const fake = db.prepare("SELECT is_fake FROM player WHERE uid=?").get(pc.placed_uid) as { is_fake: number } | undefined;
    if (!fake?.is_fake) cands.add(pc.placed_uid);
  }
  if (!cands.size) return { owner_uid: null, score: 0, state: "untracked", locked: false, evidence: { reason: "aucun candidat", orphan: pc.orphan } };

  const totalEvents = usages.reduce((s, u) => s + u.events, 0) || 1;
  const soleUser = usages.length <= 1 && pc.total_events >= minEvents;

  let best = { uid: -1, score: -Infinity, parts: {} as Record<string, unknown> };
  for (const uid of cands) {
    const u = usages.find((x) => x.uid === uid);
    const placedTerm = pc.placed_uid === uid ? w.placed : 0;
    const usageShare = u ? u.events / totalEvents : 0;
    const dist = distanceToHome(uid, pc.wid, Math.floor(pc.x), Math.floor(pc.z));
    const prox = dist === null ? 0 : Math.max(0, Math.min(1, (64 - dist) / 64));
    const netflow = u && pc.volume > 0 ? Math.max(-1, Math.min(1, (u.deposits - u.withdraws) / pc.volume)) : 0;
    const exclusiveTerm = soleUser && usageShare >= 0.9 ? w.exclusive : 0;
    const score = placedTerm + w.usage * usageShare + w.proximity * prox + w.netflow * netflow + w.exclusive * exclusiveTerm;
    if (score > best.score) {
      best = {
        uid,
        score,
        parts: {
          placed_uid: pc.placed_uid,
          usage_share: +usageShare.toFixed(3),
          proximity_dist_blocks: dist === null ? null : +dist.toFixed(1),
          proximity_factor: +prox.toFixed(3),
          netflow: +netflow.toFixed(3),
          exclusive: +exclusiveTerm,
        },
      };
    }
  }

  const top = best.uid >= 0 ? usages.find((u) => u.uid === best.uid) : undefined;
  const topShare = top ? top.events / totalEvents : 1;
  let state: string;
  let locked = false;
  if (best.score >= (t.owned_min_score ?? 0.55)) {
    // Preuve solide pour verrouiller : pose du bloc par le candidat, ou usage monopolisé avec volume d'événements.
    const strongEvidence = pc.placed_uid === best.uid || soleUser;
    state = "owned";
    locked = strongEvidence;
  } else {
    state = !pc.placed_uid && usages.length >= 3 && topShare < 0.5 ? "public" : "ambiguous";
  }

  return {
    owner_uid: best.uid,
    score: +best.score.toFixed(4),
    state,
    locked,
    evidence: {
      weights: w,
      thresholds: t,
      orphan: pc.orphan,
      sole_user: soleUser,
      top_share: +topShare.toFixed(3),
      candidates: usages.map((u) => ({ uid: u.uid, name: u.name, events: u.events, deposits: u.deposits, withdraws: u.withdraws })),
      ...best.parts,
    },
  };
}

export function computeOwners(keys?: Set<string>): number {
  const targets = keys ? [...keys] : (db.prepare("SELECT key FROM phys_container").all() as { key: string }[]).map((r) => r.key);
  const ins = db.prepare(
    `INSERT INTO container_owner(key,owner_uid,score,trust_state,locked,evidence_json) VALUES(?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET owner_uid=excluded.owner_uid, score=excluded.score,
       trust_state=excluded.trust_state, locked=excluded.locked, evidence_json=excluded.evidence_json`
  );
  db.transaction(() => {
    for (const k of targets) {
      const r = scoreContainer(k);
      ins.run(k, r.owner_uid, r.score, r.state, r.locked ? 1 : 0, JSON.stringify(r.evidence));
    }
  })();
  return targets.length;
}

/** Cycle complet sur les conteneurs. */
export function refreshContainers(): number {
  buildPhysContainers();
  assignEventsToPhys(true);
  rebuildAggregates();
  return computeOwners();
}
