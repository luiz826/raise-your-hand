// In-memory rate limiting + concurrency guard. Enough for a single-instance MVP
// backend; a multi-instance deploy would move the buckets to Redis. Keys are the
// caller's device id (falling back to IP), so one abusive client can't run up
// the API bill on the expensive endpoints.

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

// Fixed-window limiter. Returns true if the call is allowed.
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return b.count <= max;
}

// Prune expired buckets so the map doesn't grow unbounded.
const prune = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
}, 60_000);
prune.unref?.();

// Global cap on concurrent (expensive) course ingests.
let inflightIngests = 0;
export function acquireIngestSlot(max: number): boolean {
  if (inflightIngests >= max) return false;
  inflightIngests++;
  return true;
}
export function releaseIngestSlot(): void {
  inflightIngests = Math.max(0, inflightIngests - 1);
}
