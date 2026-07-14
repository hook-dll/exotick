# Configuration

Environment variables and on-disk layout. For how these are used during a
deploy, see [Deployment](deployment.md).

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `EXOTICK_ADMIN_USERNAME` | First-run admin username (2–64 chars — letters, digits, or any of `. _ - @ +`; email addresses work). Only consulted when no admin exists in the DB **and** stdin is not a TTY (Docker / CI). Ignored after any admin exists. | *(unset — interactive prompt in local dev)* |
| `EXOTICK_ADMIN_PASSWORD` | First-run admin password (≥ 8 chars). Same activation rules as the username. | *(unset — interactive prompt in local dev)* |
| `EXOTICK_DATA_DIR` | Where SQLite, uploads, and branding live. | `./data` (dev) / `/data` (Docker) |
| `PORT` | HTTP listen port. | `3001` |
| `NODE_ENV=production` | Serves the built SPA from Express at `/*`. | *(unset)* |

Two more variables exist only for admin password recovery —
`EXOTICK_RESET_USERNAME` and `EXOTICK_RESET_PASSWORD` — and are documented in
[Administration](administration.md).

---

## Data layout

Everything persistent lives under the data directory (`EXOTICK_DATA_DIR`):

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

### Wiping data

- **Reset the app but keep uploaded files:** delete `data/cms.db*` (all three
  files).
- **Wipe everything:** also delete `data/uploads/` and `data/branding/`.

Uploaded images and branding survive a database wipe unless you delete their
directories explicitly.
