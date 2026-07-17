import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'path';
import { UPLOADS_DIR } from './db';
import sectionsRouter from './routes/sections';
import testCasesRouter from './routes/testCases';
import testRunsRouter from './routes/testRuns';
import exportRouter from './routes/export';
import uploadRouter from './routes/upload';
import backupRouter from './routes/backup';
import authRouter from './routes/auth';
import samplesRouter from './routes/samples';
import usersRouter from './routes/users';
import librariesRouter from './routes/libraries';
import modulesRouter from './routes/modules';
import brandingRouter, { BRANDING_DIR } from './routes/branding';
import settingsRouter from './routes/settings';
import logRouter from './routes/log';
import { requireAuth } from './auth/middleware';
import { bootstrapAdmin, BootstrapError } from './auth/bootstrap';
import { seedDemo } from './demo';
import { pruneExpiredSessions } from './auth/sessions';

const app = express();
const PORT = process.env.PORT || 3001;

// Behind Caddy / any reverse proxy, honor X-Forwarded-Proto so cookies pick
// up the Secure flag automatically and req.ip is the real client. `1` trusts
// exactly one hop — with no proxy in front, req.ip is the socket address and
// clients can't spoof X-Forwarded-For to fool the login rate limiter.
app.set('trust proxy', 1);

// Baseline security headers on every response. Deliberately conservative: no
// script/style CSP directives, so the SPA's pre-paint inline theme script
// (client/index.html) and runtime inline styles keep working. What we DO set
// still closes real holes — frame-ancestors + X-Frame-Options defeat
// clickjacking, object-src blocks plugin-based injection, base-uri blocks
// <base> hijacking. A full script/style CSP (with a nonce for the inline theme
// script) is a worthwhile follow-up but isn't safe to bolt on blind.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  next();
});

app.use(cookieParser());
// Backup imports are multipart .zip uploads (see routes/backup.ts), so JSON
// bodies only ever carry text (sections/cases/notes) — a modest limit is plenty.
app.use(express.json({ limit: '5mb' }));

// Health endpoint — public, used by Docker HEALTHCHECK.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// X-Content-Type-Options: nosniff on the two static mounts. Defense in
// depth against a browser deciding to run an unknown-typed file as HTML.
const staticNoSniff: Parameters<typeof express.static>[1] = {
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
};

// Uploaded images are served statically, gated by an authenticated session
// so an internet attacker can't enumerate uploads.
app.use('/uploads', requireAuth, express.static(UPLOADS_DIR, staticNoSniff));

// Branding logo is intentionally PUBLIC — the login screen renders it
// before the user has a session. Same reason for /api/branding GET.
app.use('/branding', express.static(BRANDING_DIR, staticNoSniff));
app.use('/api/branding', brandingRouter);

// Auth router is mounted BEFORE the global requireAuth so login/logout/me
// are reachable when unauthenticated. Endpoints inside that DO need a
// session (e.g. /change-password) opt back in with requireAuth themselves.
app.use('/api/auth', authRouter);

// Everything below this line requires an authenticated user.
app.use('/api', requireAuth);

app.use('/api/libraries', librariesRouter);
app.use('/api/modules', modulesRouter);
app.use('/api/sections', sectionsRouter);
app.use('/api/test-cases', testCasesRouter);
app.use('/api/test-runs', testRunsRouter);
app.use('/api/export', exportRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/backup', backupRouter);
app.use('/api/samples', samplesRouter);
app.use('/api/users', usersRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/log', logRouter);

// Unknown /api paths should 404 as JSON rather than falling through to the
// SPA HTML fallback — this both keeps error messages sane and prevents
// callers from mistaking a missing API route for a working one.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve built client in production. Structure at runtime:
//   /app/server/dist/index.js  → __dirname = /app/server/dist
//   /app/client/dist/          → SPA build (mounted by Dockerfile too)
// The catch-all serves index.html so client-side routes (/login, /edit, …)
// survive a full-page refresh.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist, staticNoSniff));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Central error handler — MUST be registered last. Without it, a thrown route
// error, a multer file-filter/size rejection, or a malformed JSON body falls
// through to Express's default handler, which returns an HTML page (and leaks a
// stack trace when NODE_ENV != production) instead of the JSON the client
// expects. Here we normalize everything to JSON and never surface a 5xx stack.
const errorHandler: express.ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const anyErr = err as any;
  let status = 500;
  if (typeof anyErr?.status === 'number') status = anyErr.status;
  else if (typeof anyErr?.statusCode === 'number') status = anyErr.statusCode;
  else if (anyErr instanceof multer.MulterError) status = 400; // e.g. LIMIT_FILE_SIZE
  else if (anyErr instanceof SyntaxError) status = 400;        // malformed JSON body
  if (status >= 500) console.error('[exotick] unhandled error:', err);
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : (anyErr?.message || 'Request failed'),
  });
};
app.use(errorHandler);

// bootstrapAdmin is async (may prompt on TTY), so the whole boot sequence
// runs inside a small async wrapper. Route mounts above stay at module
// scope so tsx-watch reloads still see the same middleware order.
async function start() {
  try {
    await bootstrapAdmin();
  } catch (e) {
    if (e instanceof BootstrapError) {
      console.error('\n[exotick] Refusing to start.\n' + e.message);
      process.exit(1);
    }
    throw e;
  }

  // Opt-in demo bootstrap (env-gated, no-op unless DEMO_MODE is set). Seeds a
  // shared public login + sample content for a public demo instance.
  seedDemo();

  // Prune expired sessions on boot and hourly. Keeps the sessions table tight
  // without needing an external scheduler.
  pruneExpiredSessions();
  setInterval(() => { try { pruneExpiredSessions(); } catch { /* ignore */ } }, 60 * 60 * 1000).unref();

  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Docker sends SIGTERM before SIGKILL; without a handler in-flight requests
  // (e.g. a running backup export) get chopped and the SQLite WAL may not
  // checkpoint cleanly. Give up to 10s for connections to close.
  function shutdown(signal: NodeJS.Signals) {
    console.log(`[exotick] ${signal} received — shutting down`);
    server.close((err) => {
      if (err) {
        console.error('[exotick] error during shutdown', err);
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => {
      console.warn('[exotick] shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
