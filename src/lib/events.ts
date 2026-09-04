// Append-only telemetry log (JSONL) so the MVP success metrics are measurable:
// question volume, follow-up rate, and thumbs-up rate. One JSON object per line
// in data/events.jsonl (gitignored). Zero-dependency; fine for MVP volume.
//
// Privacy note: `ask` events store the question and answer text keyed to an
// anonymous random device id. Fine for dev dogfooding; a real deployment needs
// the caption/telemetry disclosure listed under "ship prep" in PLAN.md §5c.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EVENTS_FILE = path.join("data", "events.jsonl");
// Size-based rotation so telemetry can't fill the disk: past ~10MB the live
// file is renamed aside and a fresh one started (scripts/stats.ts reads the
// live file; rotated files are kept for manual analysis / deletion).
const MAX_BYTES = 10 * 1024 * 1024;
let approxSize = 0;
try { fs.mkdirSync("data", { recursive: true }); } catch { /* created lazily below too */ }
try { approxSize = fs.statSync(EVENTS_FILE).size; } catch { /* no log yet */ }

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function logEvent(event: Record<string, unknown>): void {
  // Async append so telemetry never blocks the request/event loop. Telemetry
  // must never break a request, so errors are swallowed with a log.
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  approxSize += line.length;
  if (approxSize > MAX_BYTES) {
    approxSize = line.length;
    const rotated = EVENTS_FILE.replace(
      /\.jsonl$/,
      `.${new Date().toISOString().slice(0, 10)}.${Date.now()}.jsonl`,
    );
    fs.rename(EVENTS_FILE, rotated, (err) => {
      if (err && err.code !== "ENOENT") console.error("event log rotation failed:", err.message);
    });
  }
  fs.appendFile(EVENTS_FILE, line, (err) => {
    if (err) console.error("event log failed:", err.message);
  });
}
