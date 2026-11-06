/** Scores composites par joueur et jour : agrège les incidents réels pour les graphes. */
import { db, getSetting } from "../db.js";

export function computeScores(): void {
  const w = getSetting("weights_json", {} as Record<string, number>);
  // Pondérations par nature d'incident ; composite plafonné à 100 pour la lecture des graphes.
  const wtTheft = w.theft_w ?? 1;
  const wtGrief = w.grief_w ?? 0.8;
  const wtAnomaly = w.anomaly_w ?? 0.45;
  const wtChat = w.chat_w ?? 0.2;

  db.exec("DELETE FROM player_score");
  db.prepare(
    `INSERT INTO player_score(uid,day,theft_s,grief_s,anomaly_s,chat_s,composite)
     SELECT uid, CAST(window_start / 86400 AS INTEGER),
            SUM(CASE WHEN kind='theft' THEN severity ELSE 0 END),
            SUM(CASE WHEN kind='grief' THEN severity ELSE 0 END),
            SUM(CASE WHEN kind='anomaly' THEN severity ELSE 0 END),
            SUM(CASE WHEN kind='chat' THEN severity ELSE 0 END),
            MIN(100, (SUM(CASE WHEN kind='theft' THEN severity ELSE 0 END) * ?
                     + SUM(CASE WHEN kind='grief' THEN severity ELSE 0 END) * ?
                     + SUM(CASE WHEN kind='anomaly' THEN severity ELSE 0 END) * ?
                     + SUM(CASE WHEN kind='chat' THEN severity ELSE 0 END) * ?) / 2)
     FROM incident
     WHERE test=0 AND uid NOT NULL AND window_start IS NOT NULL
     GROUP BY uid, CAST(window_start / 86400 AS INTEGER)`
  ).run(wtTheft, wtGrief, wtAnomaly, wtChat);
}
