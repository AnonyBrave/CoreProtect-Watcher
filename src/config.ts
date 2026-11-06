import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

function env(name: string, def?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (def !== undefined) return def;
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return v;
}

/** Lit la nouvelle variable, accepte l'ancien nom cp-sentry pour ne rien casser. */
function envLegacy(name: string, legacy: string, def?: string): string {
  const cur = process.env[name];
  if (cur !== undefined && cur !== "") return cur;
  const old = process.env[legacy];
  if (old !== undefined && old !== "") return old;
  if (def !== undefined) return def;
  throw new Error(`Variable d'environnement manquante : ${name}`);
}

export const APP_NAME = "coreprotect-watcher";
export const APP_TITLE = "CoreProtect-Watcher";

/** Fichier SQLite du cache local, en conservant l'ancien nom s'il est déjà peuplé. */
function resolveDbFile(): string {
  const custom = process.env.CP_SQLITE_FILE;
  if (custom) return custom;
  const legacy = path.join(ROOT, "data", "cp-sentry.db");
  const current = path.join(ROOT, "data", `${APP_NAME}.db`);
  return existsSync(legacy) && !existsSync(current) ? legacy : current;
}

export const cfg = {
  mysql: {
    host: env("CP_DB_HOST", "192.168.1.30"),
    port: Number(env("CP_DB_PORT", "3306")),
    user: env("CP_DB_USER", "coreprotectui"),
    password: env("CP_DB_PASSWORD", ""),
    database: env("CP_DB_NAME", "coreprotect"),
  },
  port: Number(envLegacy("CP_WATCHER_PORT", "CP_SENTRY_PORT", "8765")),
  adminToken: env("CP_ADMIN_TOKEN", `${APP_NAME}-admin`),
  discordWebhook: env("DISCORD_WEBHOOK_URL", ""),
  dbFile: resolveDbFile(),
  ingestSeconds: Number(env("CP_INGEST_SECONDS", "30")),
  fullRecomputeMinutes: Number(env("CP_RECOMPUTE_MINUTES", "10")),
};

export const WEB_DIR = path.join(ROOT, "web");
export const DIST_DIR = path.join(ROOT, "dist");
