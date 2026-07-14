# Security

exotick is a self-hosted app that stores credentials, so this page documents how
authentication is handled and what protections are built in. Recovery procedures
live in [Administration](administration.md).

---

## Password hashing

Passwords are hashed with **scrypt** (Node's built-in `crypto.scryptSync`) using
the OWASP baseline cost parameter `N = 16384` (`r = 8`, `p = 1`, 64-byte
derived key, 16-byte random salt per password).

- Each hash is stored self-describing as
  `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`, so parameters can be tuned later
  without breaking existing hashes.
- Verification uses a constant-time comparison (`timingSafeEqual`).
- The plaintext password is never stored or logged.

---

## Sessions

- Session cookies are **HttpOnly** and **SameSite=Lax**, and are marked
  **Secure** when the request arrives over HTTPS.
- Lifetime is a **30-day sliding** window.
- The database stores **`sha256(session_id)`**, never the raw cookie value — a
  leaked database row can't be replayed as a session.
- **Settings › Active sessions** lists your own logins with a device string
  (parsed from the user-agent), IP, and sign-in time. You can revoke any of
  them.

---

## Rate limiting

Both auth endpoints use a progressive lockout ladder.

### Login (per IP)

| Failed attempts | Lockout |
|---|---|
| 5 | 5 minutes |
| next 5 | 50 minutes |
| next 5 | 500 minutes (stays here) |

A wrong username and a wrong password count **identically**, so the endpoint
doesn't reveal whether a username exists. The counter resets on a successful
login.

### Change password (per user)

The same ladder applies, keyed per user rather than per IP. A stolen session
that starts guessing the current password is stopped on the same schedule, and
the lock applies to the account across **all** its sessions.

---

## Public logo & SVG rejection

The branding logo is served **publicly** (the login page must load it before any
user is authenticated). Uploads are restricted to **PNG / JPG / WebP**, and
**SVG is intentionally rejected**: SVG is a scriptable XML document, and serving
attacker-controlled SVG from the app's own origin would be an XSS vector.

---

## Transport security

exotick speaks plain HTTP and does **not** terminate TLS itself. For any
deployment beyond a trusted LAN, put it behind a reverse proxy that terminates
HTTPS — see [Deployment › HTTPS](deployment.md#https--reverse-proxy).
