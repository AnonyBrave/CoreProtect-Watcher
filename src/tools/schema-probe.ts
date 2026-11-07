/** Sonde du schéma CoreProtect : colonnes ordonnées + volumes, pour le parseur de dumps SQL. */
import { q, closePool } from "../mysql.js";

const TABLES = [
  "co_block",
  "co_container",
  "co_item",
  "co_session",
  "co_chat",
  "co_command",
  "co_user",
  "co_world",
  "co_material_map",
  "co_username_log",
];

async function main() {
  for (const t of TABLES) {
    const cols = await q<{ COLUMN_NAME: string; ORDINAL_POSITION: number; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [t],
    );
    if (!cols.length) {
      console.log(`${t}: ABSENTE`);
      continue;
    }
    const n = await q<{ c: number }>(`SELECT COUNT(*) c FROM \`${t}\``);
    console.log(`${t}: ${n[0]?.c ?? 0} lignes | ${cols.map((c) => `${c.ORDINAL_POSITION}.${c.COLUMN_NAME}:${c.DATA_TYPE}`).join(", ")}`);
  }

  // Échantillon : valeurs d'une ligne de chaque grosse table (types vus côté client).
  for (const t of ["co_block", "co_container", "co_item"]) {
    const rows = await q(`SELECT * FROM \`${t}\` ORDER BY rowid DESC LIMIT 2`);
    console.log(`${t} échantillon: ${JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`);
  }

  const engines = await q<{ TABLE_NAME: string; ENGINE: string }>(
    `SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'co_%'`,
  );
  console.log("engines:", JSON.stringify(engines));

  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
