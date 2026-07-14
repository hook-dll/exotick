# Administration

Day-to-day admin tasks: managing teammates and recovering access. For the
capability matrix behind the roles named here, see
[Features › Roles](features.md#roles--permissions).

---

## Managing users

Add and manage teammates at **Settings › Users** (admin only). Each user has one
role: **editor**, **runner**, or **watcher**. (`admin` is created during
first-run bootstrap and is never offered in the role picker — there is exactly
one admin per install.)

From the same screen an admin can reset any user's password (see below) and
enable or disable accounts.

---

## Password recovery

There is **no email / self-service reset** by design. How you get back in
depends on the role.

### Editors, runners, and watchers — ask the admin

Regular users have no self-reset. If you're locked out:

1. Contact your admin.
2. The admin resets your password at **Settings › Users › Reset password** and
   hands you the new one. This also signs you out everywhere, so an old stolen
   session can't linger.
3. Change it to something only you know at **Settings › Change my password**.

### Admin — reset from the host

The admin has no one above them, so recovery lives on the **host** — which is
fine, because whoever runs exotick already has shell / container access. One
command resets the admin password and revokes that admin's sessions; there's no
need to drop the database.

**Local:**

```bash
npm run reset-admin
```

**Docker:**

```bash
docker compose exec exotick node server/dist/reset-admin-cli.js
```

Both prompt for the new password (hidden input, entered twice). For unattended
use, set the recovery environment variables before running:

| Variable | Purpose |
|---|---|
| `EXOTICK_RESET_USERNAME` | Which admin to reset (only needed if more than one admin somehow exists). |
| `EXOTICK_RESET_PASSWORD` | The new password (≥ 8 chars). Skips the interactive prompt. |

Simplest of all: store the admin password in a password manager and you'll never
need this.
