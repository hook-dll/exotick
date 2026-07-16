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

3. **Set the admin password:** Render will prompt for `EXOTICK_ADMIN_PASSWORD`
   (it's marked secret, so it isn't in the repo). Enter a strong value.
   The username defaults to `admin`.

4. **Apply** → Render builds the Dockerfile and deploys. First build takes a few
   minutes. When live you get `https://exotick.onrender.com` (or a name suffix
   if `exotick` is taken).

5. **Seed the demo:** log in as `admin`, go to Edit Mode → **Load samples**.

## What to expect (free plan)

- **Data is disposable.** No persistent disk on free — the SQLite DB resets on
  each redeploy and each wake-from-idle. The admin is always recreated from the
  env vars, but entered data doesn't survive a sleep. Reload samples as needed.
- **Cold starts.** The instance sleeps after ~15 min idle; the next visit takes
  ~30-60s to wake.
- **Auto-deploy.** `autoDeploy: true` means every push to `main` redeploys.

## If you outgrow the free plan

Add a Render **Disk** mounted at `/data` (paid) and data persists across
restarts — no app changes needed, since the DB already lives under `/data`.
