# exotick

A self-hosted test-case management / test-run app. React SPA + Express API, SQLite storage, single-origin.

## Authoritative references (read these before deep work)
- **`project_summary.txt`** — the maintainer's deep reference: full stack, directory map, DB schema, auth/session model, route-gating table, env vars, and a long list of non-obvious gotchas. **Consult this before changing anything non-trivial.** If a "stable feature" isn't described there, treat it as not stable.
- **`readme.md`** + **`docs/`** — user-facing docs and feature notes.

## Stack (at a glance)
- **Client:** React 18 + TypeScript + Vite 8 + Tailwind 3 + React Router v6 (`client/`)
- **Server:** Node 24 + Express 4 + TypeScript, `node:sqlite` (built-in, no native deps), scrypt auth (`server/`)
- **DB:** SQLite at `data/cms.db` (WAL, foreign_keys ON) — gitignored, created on first run
- **Ports:** dev → server 3001, client 5173 (Vite proxies `/api` `/uploads` `/branding` → 3001); prod → 3001 only (Express serves the built SPA)

## Commands
```
npm run setup         # install root + server + client deps
npm run dev           # both dev servers; predev prompts for admin creds on first run
npm run build         # vite build (client) + tsc (server)
npm start             # NODE_ENV=production, serves SPA from server/dist
npm run reset-admin   # host-side admin password recovery (locked-out admin)
```
Docker: `docker compose up -d --build` (needs `EXOTICK_ADMIN_PASSWORD` in `.env`; binds 127.0.0.1:3001, TLS terminated by a host reverse proxy).

## Conventions & environment
- **Windows for editing, Linux/Docker for running.** `.gitattributes` normalizes text to LF — keep it that way.
- **TypeScript strict** on both sides. Server is CommonJS/ES2020; client is ESNext.
- **Single-origin, no CORS** by design. Cookie is `SameSite=Lax`; don't add CORS without revisiting that.
- **Roles:** `admin > editor > runner > watcher`, but admin is deliberately excluded from the test-run workflow (see `requireCanRun` in `server/src/auth/middleware.ts`). `admin` is bootstrap-only — never offered in UI role pickers.

## Top gotchas (full list in project_summary.txt §11)
- **SQLite timestamps have no `Z`.** `CURRENT_TIMESTAMP` writes `YYYY-MM-DD HH:MM:SS` UTC without a marker; `new Date(str)` parses it as *local*. On the client, route elapsed-time math through `client/src/util/serverDate.ts::parseServerTs`. On the server, compare via SQL `strftime('%s', ...)`.
- **Session cookie value ≠ `sessions.id`.** Cookie holds the raw 32-byte id; the DB stores `sha256(raw)`. `resolveSession` hashes before lookup.
- **Uploads reject SVG** (XSS surface). Both extension and multipart Content-Type must match a raster whitelist.
- **Backup zip covers only the library + referenced upload images** — not run history, users, sessions, or branding.
- **Migrations are idempotent and run on every server start** (`server/src/db.ts`).
