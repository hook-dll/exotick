# exotick

Simple yet powerful self-hosted test case management. 
- Multiple test case libraries, sections and cases with markdown notes and pasted images
- Compose runs from any subset in a selected library
- Mark pass/fail live. Don't mark to skip on finish
- PDF export for completed test runs, backup import/export
- User roles with limited permissions

One process, one SQLite file. Runs on a laptop, a LAN box, or a VPS. For small teams and basic requirements.

---

## Install

Requirements: **Node.js 24+**.

```bash
git clone https://github.com/hook-dll/exotick.git
cd exotick
npm run setup     # installs root + client + server deps
npm run dev       # starts backend :3001 + client :5173
```

Open http://localhost:5173.

On first launch the terminal prompts for an admin username and password. Sign in via web, done. Change the admin password later at **Settings › Change my password**. <mark>No way to restore forgotten admin password</mark>, must drop database and start over. Add teammates at **Settings › Users** (roles: editor / runner / watcher).

For Docker or headless boot, `EXOTICK_ADMIN_USERNAME` + `EXOTICK_ADMIN_PASSWORD` env vars replace the prompt. Both are ignored once an admin exists.

---

## Features

**Libraries** — Sections and cases live inside named libraries. Fresh install ships with one called `Main`; create more from Edit Mode. Runs are scoped to a single library, composing across libraries is not allowed. Sample data loads into a fresh `Samples` library, never mixed with real data. Delete is refused if any run still references the library, or if it's the last one.

**Editing** — Sections with optional colors, cases with markdown notes and inline images. Bulk create / move / duplicate / delete / merge. Reorder with arrow buttons.

**Composing** — Pick a library, pick cases across sections, name the run, pick a runner from the roster dropdown (watchers hidden for all, admin hidden for non-admins). Save as draft or start immediately.

**Running** — Pass/Fail per case, each click saves. Only the current runner can mark. Others viewing an active run see it read-only; editors + runners get a Take over button. Finish auto-skips remaining items.

**Take over** — Only for **active** runs (drafts can't be taken over — that would be a pure steal from whoever's composing). Requires to type in a reason ≥ 10 characters. Blocked during the cooldown window since the runner's last mark. Cooldown is admin-configurable at **Settings › Take over cooldown** (default 60 min; 0 disables the timing check but not the reason). Server never leaks "N minutes left" to callers.

**Roles** — `admin > editor > runner > watcher` for read / edit / manage capabilities, but **admin doesn't run tests**. Editors and runners are the only roles that can compose, start, mark, finish, or take over.

| Capability | admin | editor | runner | watcher |
|---|---|---|---|---|
| Manage users / branding / backup / log | ✅ | ❌ | ❌ | ❌ |
| Edit libraries / sections / cases | ✅ | ✅ | ❌ | ❌ |
| Delete draft runs | ✅ | ✅ | ❌ | ❌ |
| Delete active / completed runs | ✅ | ❌ | ❌ | ❌ |
| Compose run / start / mark / finish / take over | ❌ | ✅ | ✅ | ❌ |
| View active runs, history | ✅ | ✅ | ✅ | ✅ |

There is exactly one admin per install. Bootstrap only; the UI never offers `admin` in role pickers.

**Contributors** — Every mark or skip records the actor's username. History Detail and PDF export show a Contributors summary sorted by count.

**History** — All completed runs, filterable by library. Detail view shows summary + results grouped by section + Contributors, with a PDF export link.

**PDF export** — Full library, a bulk-selected subset, or a specific run's results. Cyrillic + non-Latin scripts render correctly (drop `DejaVuSans.ttf` + `DejaVuSans-Bold.ttf` into `server/fonts/` for cross-platform consistency).

**Backup** (admin) — Per-library `.zip` (backup.json + referenced upload files). Import as a new library, or merge / replace into the current one. **Not** in the zip: run history, users, sessions, branding, other libraries, the event log.

**Branding** (admin) — Custom app name (≤ 40 chars) and logo (PNG/JPG/WebP, 2 MB). SVG is intentionally rejected — it's a scriptable XML document and the logo is served publicly.

**Log** (admin) — Records `login`, `edit`, `compose`, `start`, `finish`, `take_over`, `password_change`, `password_reset` superficially, just to register the event. For example it doesn't show what was particularly added or deleted from library, currently I think that will overcomplicate the app. Each row: when / event / actor / details (library, run, previous runner, reason — whichever apply). Library and run names in details are clickable. Rows survive their run / library being deleted (snapshot columns keep them readable). Browse the latest 200 at `/log` or download the full history as CSV. **Not** included in backups.

**Sessions** — HttpOnly cookies, SameSite=Lax, 30-day sliding lifetime. DB stores `sha256(session_id)`, not the raw cookie. **Settings › Active sessions** lists your own logins with device (parsed from user-agent), IP, and signed-in time; revoke any of them.

**Login rate-limit** — Progressive per IP: 5 failed attempts → 5 min lockout, next 5 → 50 min, next 5 → 500 min (stays there). Wrong username and wrong password count identically. Reset on successful login.

**Change-password rate-limit** — Same ladder, per user. A stolen session that starts guessing gets stopped on the same schedule and locks the endpoint for the account across all sessions.

---

## Deployment

**LAN dev** — `npm run dev` on the host. Others browse `http://<host-ip>:5173`. Open port 5173 in the host firewall if needed:

```powershell
New-NetFirewallRule -DisplayName "exotick (Vite 5173)" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 5173 -Profile Private
```

**Docker (VPS)** —
```bash
cp .env.example .env             # then set EXOTICK_ADMIN_PASSWORD in .env
docker compose up -d --build     # compose refuses to start until it's set
```
`docker compose` reads `.env` automatically. `EXOTICK_ADMIN_USERNAME` defaults to `admin`; `EXOTICK_ADMIN_PASSWORD` has no default — compose fails fast with a clear error until you set it, so no publicly-known default password ever ships. Both are ignored once an admin exists. Container binds to `127.0.0.1:3001`. Data (`cms.db`, `uploads/`, `branding/`) persists in the `exotick-data` volume across rebuilds.

**HTTPS** — TLS is your responsibility. Put a reverse proxy in front (Caddy, nginx, Traefik) and terminate TLS there. Real domain + Let's Encrypt is the low-friction path — `deploy/Caddyfile.example` is a starter. No domain? Register a free dynamic-DNS hostname ([DuckDNS](https://www.duckdns.org), [dynv6](https://dynv6.com)), point it at your public IP, forward ports **80** and **443** to your host, and drop this into your Caddyfile:

```caddyfile
yourname.duckdns.org {
    reverse_proxy 127.0.0.1:3001
}
```

Reload Caddy — it fetches a real Let's Encrypt cert within a minute. Anything else (self-signed, mkcert, Tailscale, Cloudflare Tunnel) is a choice for your deployment.

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `EXOTICK_ADMIN_USERNAME` | First-run admin username (2-64 chars — letters, digits, or any of `. _ - @ +`; email addresses work). Only consulted when no admin exists in the DB and stdin is NOT a TTY (Docker / CI). Ignored after any admin exists. | *(unset — interactive prompt in local dev)* |
| `EXOTICK_ADMIN_PASSWORD` | First-run admin password (≥ 8 chars). Same rules. | *(unset — interactive prompt in local dev)* |
| `EXOTICK_DATA_DIR` | Where SQLite + uploads + branding live. | `./data` (dev) / `/data` (Docker) |
| `PORT` | HTTP listen port. | `3001` |
| `NODE_ENV=production` | Serves the built SPA from Express at `/*`. | *(unset)* |

---

## Data layout

```
data/
  cms.db            SQLite database
  cms.db-shm        SQLite WAL sidecars (transient)
  cms.db-wal
  uploads/          images referenced by test-case notes; served at
                    /uploads/* (auth-gated)
  branding/         admin-uploaded logo (single file); served publicly
                    at /branding/* so the login page can load it
```

Wipe everything: delete `data/cms.db*`. Uploaded images and branding survive unless you also delete `data/uploads/` and `data/branding/`.

---

## Easter-egg

Switch light/dark modes a few times to defeat boredom.

---

## License

This project is source-available under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)** license. 

You are free to fork, modify, and share this project for personal and educational use. Commercial use of this software, or any applications derived from it, is strictly prohibited. See the [LICENSE](LICENSE) file for details.

---

## About me

I've been working in testing for over 10 years now. Not a fan of the current commercial solutions on the test management system market. Claude Code helped me build the system I wanted for myself, slightly exotic one. I want to share it with you in case it works for you too.