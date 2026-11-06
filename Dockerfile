# syntax=docker/dockerfile:1
# CoreProtect-Watcher : ingestion MySQL -> SQLite + API Fastify + UI React, en un seul conteneur.
# Multi-stage : (1) dépendances de production compilées pour musl/Alpine, (2) build Vite de l'UI,
# (3) runtime minimal (node_modules de prod + dist/), exécuté sans root.

# ---------- 1) Dépendances de production ----------
FROM node:22-alpine AS deps
# Chaîne de compilation nécessaire pour better-sqlite3 sur Alpine (musl).
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- 2) Interface (Vite -> dist/) ----------
FROM node:22-alpine AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build:web

# ---------- 3) Runtime ----------
FROM node:22-alpine AS runtime
RUN apk add --no-cache tzdata
ENV TZ=Europe/Paris NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=ui /app/dist ./dist
COPY package.json ./
COPY src ./src
# Le cache SQLite vit dans le volume monté sur /app/data.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8765
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "-e", "const p=Number(process.env.CP_WATCHER_PORT)||8765; fetch(`http://127.0.0.1:${p}/api/worlds`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
