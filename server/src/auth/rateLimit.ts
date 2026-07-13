// Progressive login cooldown, per-IP, in-memory. Used exclusively by the
// /login endpoint. A determined attacker with a botnet is out of scope for
// a small self-hosted tool — operators can put Cloudflare / fail2ban in
// front for that.
//
// Ladder: after every batch of ATTEMPTS_PER_TIER failed attempts, the IP is
// locked out for a longer window than the previous batch. Tier persists
// across the wait; a successful login clears the whole bucket.
//
//   Tier 1 (attempts 1-5)   →   5 minutes
//   Tier 2 (attempts 6-10)  →  50 minutes
//   Tier 3 (attempts 11+)   → 500 minutes  (stays here indefinitely)

const ATTEMPTS_PER_TIER = 5;
const LOCKOUTS_MS = [
  5 * 60 * 1000,
  50 * 60 * 1000,
  500 * 60 * 1000,
] as const;
const MAX_TIER = LOCKOUTS_MS.length; // 3
// Prune stale buckets whose last activity is older than this.
const IDLE_PRUNE_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

interface Bucket {
  // Failed attempts accumulated within the CURRENT tier. Resets to 0 each
  // time the tier advances (and, of course, on a successful login).
  failCount: number;
  // How many tiers of lockout have been triggered so far. 0 = never locked.
  tier: number;
  // Epoch ms when the current lockout ends. 0 when not locked.
  lockUntil: number;
  // Last touch time — used only for idle-pruning stale buckets.
  lastSeen: number;
}

const buckets = new Map<string, Bucket>();

function get(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { failCount: 0, tier: 0, lockUntil: 0, lastSeen: Date.now() };
    buckets.set(key, b);
  }
  return b;
}

/**
 * Read-only lock check. Call BEFORE verifying the password so a locked IP
 * can't even measure whether the username exists.
 */
export function check(key: string): { allowed: boolean; retryAfterMs: number } {
  const b = buckets.get(key);
  if (!b) return { allowed: true, retryAfterMs: 0 };
  const now = Date.now();
  if (b.lockUntil > now) {
    return { allowed: false, retryAfterMs: b.lockUntil - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Record one failed login. Increments the current tier's counter; on the
 * ATTEMPTS_PER_TIER-th failure, advances the tier and locks the IP for the
 * corresponding window. Attempts that arrive during an active lockout do
 * NOT count (attackers can't punish the ladder by hammering it).
 */
export function recordFailure(key: string): { locked: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = get(key);
  b.lastSeen = now;

  // Already locked — swallow the attempt, tell the caller how long to wait.
  if (b.lockUntil > now) {
    return { locked: true, retryAfterMs: b.lockUntil - now };
  }

  b.failCount += 1;
  if (b.failCount >= ATTEMPTS_PER_TIER) {
    b.tier = Math.min(b.tier + 1, MAX_TIER);
    b.lockUntil = now + LOCKOUTS_MS[b.tier - 1];
    b.failCount = 0;
    return { locked: true, retryAfterMs: b.lockUntil - now };
  }
  return { locked: false, retryAfterMs: 0 };
}

/**
 * Clear everything for this key. Called on a successful login so the
 * legit user isn't punished by prior fat-fingering.
 */
export function reset(key: string): void {
  buckets.delete(key);
}

// Prune buckets that haven't been touched in a while so the map doesn't
// grow forever from one-shot probes. Only removes entries that are BOTH
// idle AND not currently locked (an active lockout stays, even if idle).
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.lockUntil > now) continue;
    if (now - b.lastSeen > IDLE_PRUNE_MS) buckets.delete(k);
  }
}, PRUNE_INTERVAL_MS).unref();
