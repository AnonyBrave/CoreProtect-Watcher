import mysql from "mysql2/promise";
import { cfg } from "./config.js";

let pool: mysql.Pool | null = null;

export async function getPool(): Promise<mysql.Pool> {
  if (!pool) {
    pool = await mysql.createPool({
      host: cfg.mysql.host,
      port: cfg.mysql.port,
      user: cfg.mysql.user,
      password: cfg.mysql.password,
      database: cfg.mysql.database,
      connectionLimit: 2,
      // Convention lecture seule : le code n'émet que des SELECT (l'utilisateur MySQL est en lecture).
      dateStrings: true,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
export async function q<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
  const p = await getPool();
  const [rows] = await p.query(sql, params as never);
  return rows as T[];
}

/** Colonnes réellement présentes dans la base (robuste face aux versions CoreProtect). */
export async function columnsOf(table: string): Promise<Set<string>> {
  const rows = await q<{ COLUMN_NAME: string }>(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table]
  );
  return new Set(rows.map((r) => r.COLUMN_NAME.toLowerCase()));
}

/** Parse les paires lISIBLES d'un blob Java Serialization (metadata CoreProtect).
 *  On récupère les chaînes TC_STRING sans faire de désérialisation complète. */
export function parseJavaStrings(buf: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x74 && buf[i + 1] === 0x00) {
      const len = buf.readUInt16BE(i + 2);
      if (len > 1 && len <= 64 && i + 4 + len <= buf.length) {
        const s = buf.toString("latin1", i + 4, i + 4 + len);
        if (/^[\x20-\x7e]+$/.test(s)) {
          out.push(s);
          i += 3 + len;
        }
      }
    }
  }
  return out;
}

export function metaToKv(buf: Buffer | null): string {
  if (!buf) return "";
  const toks = parseJavaStrings(buf);
  const pairs: string[] = [];
  for (let i = 0; i + 1 < toks.length; i += 2) pairs.push(`${toks[i]}=${toks[i + 1]}`);
  return JSON.stringify(pairs.length ? Object.fromEntries(pairs.map((p) => p.split("="))) : toks);
}
