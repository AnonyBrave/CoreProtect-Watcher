// Lecture seule : statuts d'incidents et totaux de score par joueur.
import Database from "better-sqlite3";
const db = new Database(process.argv[2], { readonly: true });

const incidents = db.prepare(`
  SELECT id,uid,kind,status,severity,created_at
  FROM incident
  WHERE test=0
  ORDER BY uid,id
`).all();

const totals = db.prepare(`
  SELECT p.uid,p.name,COUNT(ps.day) AS days,
         SUM(ps.theft_s+ps.grief_s+ps.anomaly_s+ps.chat_s+ps.dupe_s) AS raw_sum,
         COALESCE(SUM(ps.composite),0) AS composite_total
  FROM player p
  LEFT JOIN player_score ps ON ps.uid=p.uid
  GROUP BY p.uid,p.name
`).all();

console.log(JSON.stringify({incidents,totals},null,2));
