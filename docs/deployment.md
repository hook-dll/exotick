# Deployment

exotick is one process and one SQLite file, so deployment is deliberately
simple. Pick the section that matches where you're running it. For the
environment variables referenced here, see [Configuration](configuration.md).

---

## Local / LAN

Run the dev servers on the host:

```bash
npm run dev
```

Other machines on the network browse to `http://<host-ip>:5173`. On Windows,
open the Vite port in the host firewall if the page isn't reachable:

```powershell
New-NetFirewallRule -DisplayName "exotick (Vite 5173)" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 5173 -Profile Private
```

LAN mode is fine for trying exotick out or for a trusted internal network. For
anything reachable beyond that, put it behind HTTPS (below).

---

## Docker (VPS)

1. Copy the example env file and set an admin password:

   ```bash
   cp .env.example .env      # then set EXOTICK_ADMIN_PASSWORD in .env
   ```

2. Build and start:

   ```bash
   docker compose up -d --build
   ```

Notes:

- `docker compose` reads `.env` automatically.
- `EXOTICK_ADMIN_USERNAME` defaults to `admin`. `EXOTICK_ADMIN_PASSWORD` has
  **no default** — compose fails fast with a clear error until you set it, so no
  publicly-known default password ever ships. Both are ignored once an admin
  exists.
- The container binds to `127.0.0.1:3001`.
- Data (`cms.db`, `uploads/`, `branding/`) persists in the `exotick-data` volume
  across rebuilds.

---

## HTTPS / reverse proxy

TLS is **your** responsibility. exotick speaks plain HTTP; terminate TLS in a
reverse proxy in front of it (Caddy, nginx, Traefik). A real domain plus Let's
Encrypt is the low-friction path, and `deploy/Caddyfile.example` is a starter.

### No domain? Use dynamic DNS + Caddy

1. Register a free dynamic-DNS hostname, e.g. [DuckDNS](https://www.duckdns.org)
   or [dynv6](https://dynv6.com), and point it at your public IP.
2. Forward ports **80** and **443** from your router to the host.
3. Add this to your Caddyfile:

   ```caddyfile
   yourname.duckdns.org {
       reverse_proxy 127.0.0.1:3001
   }
   ```

4. Reload Caddy. It fetches a real Let's Encrypt certificate within a minute.

Anything else — self-signed certs, mkcert, Tailscale, Cloudflare Tunnel — is a
valid choice for your setup; it's just not something exotick prescribes.
