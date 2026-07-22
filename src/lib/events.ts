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
try { fs.mkdirSync("data", { recursive: true }); } catch { /* created lazily below too */ }

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function logEvent(event: Record<string, unknown>): void {
  // Async append so telemetry never blocks the request/event loop. Telemetry
  // must never break a request, so errors are swallowed with a log.
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  fs.appendFile(EVENTS_FILE, line, (err) => {
    if (err) console.error("event log failed:", err.message);
  });
}
