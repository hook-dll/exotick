# syntax=docker/dockerfile:1

# ─── Stage 1: build ─────────────────────────────────────────────────────────
# Installs every workspace's deps (dev included), builds the client with Vite
# and compiles the server with tsc. Kept off the runtime image entirely.
FROM node:24-alpine AS builder

WORKDIR /app

# Copy manifests first so the layer cache survives source-only edits.
COPY package.json package-lock.json* ./
COPY client/package.json client/
COPY server/package.json server/

# Install root + workspaces. Root pulls in cross-env / concurrently which the
# build scripts reference; the child installs pull in Vite, tsc, tailwind, etc.
RUN npm install --no-audit --no-fund \
 && npm install --prefix client --no-audit --no-fund \
 && npm install --prefix server --no-audit --no-fund

COPY client ./client
COPY server ./server

# Client (Vite → client/dist) + server (tsc → server/dist).
RUN npm run build --prefix client \
 && npm run build --prefix server

# ─── Stage 2: runtime ───────────────────────────────────────────────────────
# Slim Node image with only the server's production deps and the two dist/
# folders. No source, no TypeScript, no client build tooling.
FROM node:24-alpine AS runtime

# Non-root user for defense-in-depth (uid 1000 aligns with Alpine's `node` user).
RUN addgroup -S exotick && adduser -S -G exotick exotick

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    EXOTICK_DATA_DIR=/data

# Install ONLY server's production deps in the runtime layer.
COPY server/package.json server/package-lock.json* ./server/
RUN npm install --prefix server --omit=dev --no-audit --no-fund

# Compiled server + built client bundle.
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# The server needs to be able to write to /data (SQLite + uploads + session
# secret). docker-compose.yml mounts the actual host directory here.
RUN mkdir -p /data && chown -R exotick:exotick /data /app

USER exotick

EXPOSE 3001

# The /api/health endpoint is public in every mode; if it isn't answering,
# the container is unhealthy no matter what auth mode we're in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:${PORT:-3001}/api/health || exit 1

CMD ["node", "server/dist/index.js"]
