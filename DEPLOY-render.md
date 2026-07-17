# Deploying exotick to Render (free, always-on, no credit card)

The repo already carries `render.yaml`, so Render can build and run the
production Dockerfile with one Blueprint. Your only manual steps are creating a
Render account and picking a password — both quick, no card required.

## Steps

1. **Sign up** at https://render.com — use "Sign in with GitHub" (account
   `hook-dll`). No payment method is requested for the free plan.

2. **New Blueprint:** in the dashboard click **New +** → **Blueprint**.
   Authorize Render to read your GitHub repos if prompted, then select
   **hook-dll/exotick**. Render detects `render.yaml` automatically.

3. **Set your private admin password:** Render will prompt for
   `EXOTICK_ADMIN_PASSWORD` (marked secret, so it isn't in the repo). Enter a
   strong value — this is YOUR owner login (username `owner`), not shared.

4. **Apply** → Render builds the Dockerfile and deploys. First build takes a few
   minutes. When live you get `https://exotick.onrender.com` (or a name suffix
   if `exotick` is taken).

5. **That's it — it's demo-ready.** `render.yaml` sets `DEMO_MODE=1`, so on boot
   the app seeds a shared public login (`demo` / `demo`, editor role) and a
   Samples library automatically. The login screen shows the demo credentials.

## Demo mode (how the shared login is safe)

`DEMO_MODE=1` (set in `render.yaml`) does three things so you can publish one
login to the world:
- Seeds a fixed **editor** account `demo` / `demo` — can create/edit cases and
  compose/run tests, but can't manage users, branding, or backups.
- **Blocks password changes** (`POST /api/auth/change-password` → 403), so no
  visitor can rotate the shared password and lock everyone else out.
- Auto-loads sample data whenever the instance is empty.

Your private `owner` admin (from `EXOTICK_ADMIN_PASSWORD`) keeps full control.
Change the demo username/password via the `EXOTICK_DEMO_USERNAME` /
`EXOTICK_DEMO_PASSWORD` env vars. To run a normal (non-demo) instance, remove
`DEMO_MODE` or set it to `0`.

## What to expect (free plan)

- **Data is disposable.** No persistent disk on free — the SQLite DB resets on
  each redeploy and each wake-from-idle. The demo login and samples are always
  recreated on boot, but data entered during a session doesn't survive a sleep.
- **Cold starts.** The instance sleeps after ~15 min idle; the next visit takes
  ~30-60s to wake.
- **Auto-deploy.** `autoDeploy: true` means every push to `main` redeploys.

## If you outgrow the free plan

Add a Render **Disk** mounted at `/data` (paid) and data persists across
restarts — no app changes needed, since the DB already lives under `/data`.
