# Features

A full reference for what exotick does. For a one-paragraph overview see the
[README](../readme.md); for the auth/session details see
[Security](security.md).

Most of exotick is organized around a single idea: **cases live in libraries,
and a run is a snapshot of some cases from one library.** The sections below
follow that flow — build a library, compose a run, execute it, then review and
export the history.

---

## Libraries

Sections and cases live inside named **libraries**. A fresh install ships with
one library called `Main`; create more from Edit Mode.

- A run is always scoped to a **single** library — composing cases across
  libraries is not allowed.
- Sample data loads into its own `Samples` library and is never mixed with your
  real data.
- Deleting a library is refused if any run still references it, or if it's the
  last remaining library.

## Editing

- **Sections** with optional colors group related cases; cases may also be left
  unsectioned.
- **Cases** carry a description plus markdown notes and inline pasted images.
- **Bulk operations**: create, move, duplicate, delete, and merge cases in one
  action.
- Reorder sections and cases with arrow buttons.

---

## The run lifecycle

A run moves through these stages in order.

### 1. Compose

Pick a library, select cases across its sections, name the run, and pick a
runner from the roster dropdown. The roster hides watchers from everyone (they
can't run), and hides the admin account from non-admins. Save the composed run
as a **draft**, or start it immediately.

### 2. Run & mark

Mark each case **Pass** or **Fail**; every click saves immediately. Only the
**current runner** can mark. Anyone else viewing an active run sees it
read-only — editors and runners additionally get a **Take over** button (see
below).

### 3. Take over

Take over is only available for **active** runs — a draft can't be taken over,
because that would be a pure steal from whoever is still composing it.

- The person taking over must type a **reason of at least 10 characters**.
- Take over is blocked during a **cooldown window** measured from the current
  runner's last mark. The cooldown is admin-configurable at **Settings › Take
  over cooldown** (default 60 minutes; setting it to `0` disables the *timing*
  check but not the required reason).
- The server never leaks how much cooldown time remains to callers.

### 4. Finish

Finishing a run **auto-skips** any remaining unmarked items and moves the run to
completed.

### 5. History & contributors

- **History** lists every completed run and is filterable by library.
- A run's **Detail** view shows a summary, results grouped by section, and a
  **Contributors** panel.
- **Contributors** are derived from the actor recorded on every mark or skip,
  sorted by count. The same panel appears in the PDF export.

### 6. PDF export

Export a full library, a bulk-selected subset of cases, or a specific run's
results to PDF. Cyrillic and other non-Latin scripts render correctly. For
cross-platform font consistency, drop `DejaVuSans.ttf` and `DejaVuSans-Bold.ttf`
into `server/fonts/`.

---

## Roles & permissions

Roles are ordered `admin > editor > runner > watcher`, but the ordering is about
*management* capability, not *running* — note that **admin doesn't run tests**.
Composing, starting, marking, finishing, and taking over are reserved for
editors and runners.

| Capability | admin | editor | runner | watcher |
|---|---|---|---|---|
| View current runs (active / draft) & history | ✅ | ✅ | ✅ | ✅ |
| Export a run's results (PDF) | ✅ | ✅ | ✅ | ✅ |
| Manage own password & sessions | ✅ | ✅ | ✅ | ✅ |
| Browse libraries, sections & cases | ✅ | ✅ | ✅ | ❌ |
| Export a library / case subset (PDF) | ✅ | ✅ | ✅ | ❌ |
| Compose run / start / mark / finish / take over | ❌ | ✅ | ✅ | ❌ |
| Edit libraries / sections / cases (+ image upload, load samples) | ✅ | ✅ | ❌ | ❌ |
| Delete draft (composing) runs | ✅ | ✅ | ❌ | ❌ |
| Delete active / completed runs | ✅ | ❌ | ❌ | ❌ |
| Manage users / branding / backup / log / take-over cooldown | ✅ | ❌ | ❌ | ❌ |

(Unauthenticated requests can reach only the health check and the public
branding logo.)

Two deliberate asymmetries are worth calling out:

- **Admin doesn't run tests.** The admin account manages the install; composing,
  starting, marking, finishing, and taking over are reserved for editors and
  runners.
- **Watchers can't browse the library.** A watcher is typically a manager or
  external auditor — they see *current work* (active and draft runs) and
  *history* (what was tested and how), but not the library catalog, its cases,
  or a library-content export. Runners **can** browse library content, because
  picking cases is how they compose a run. This is enforced on the server, not
  just hidden in the UI.

There is exactly **one admin per install**. The admin is created during
bootstrap only; the UI never offers `admin` in any role picker. Adding and
managing teammates is covered in [Administration](administration.md).

---

## Admin tools

These features are available to the admin only.

### Backup

Per-library `.zip` archive containing `backup.json` plus the upload files that
library's cases reference. On import you can create a **new** library from the
archive, or **merge / replace** into the current one.

The archive deliberately does **not** contain: run history, users, sessions,
branding, other libraries, or the event log.

### Branding

Set a custom app name (≤ 40 characters) and logo (PNG / JPG / WebP, up to 2 MB).
SVG is intentionally **rejected**: it's a scriptable XML document and the logo
is served publicly — see [Security](security.md) for the reasoning.

### Log

The event log records the following events superficially — enough to register
that they happened, without a full diff of what changed:

`login`, `edit`, `compose`, `start`, `finish`, `take_over`, `password_change`,
`password_reset`.

- Each row captures: **when**, **event**, **actor**, and **details** (library,
  run, previous runner, reason — whichever apply).
- Library and run names in the details are clickable.
- Rows **survive** their run or library being deleted, because snapshot columns
  keep them readable.
- Browse the latest 200 at `/log`, or download the full history as CSV.
- The event log is **not** included in backups.

This is intentionally not a full audit trail — it doesn't record, for example,
exactly what was added to or removed from a library, to keep the app simple.

---

## Easter egg

Switch between light and dark mode a few times to defeat boredom.
