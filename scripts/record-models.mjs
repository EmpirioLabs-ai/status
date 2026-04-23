#!/usr/bin/env node
// scripts/record-models.mjs
// Fetches the gateway /health endpoint and appends a sample for each worker
// into history/models-state.json. New workers are auto-discovered.
//
// State shape (kept compact; one file for all workers):
// {
//   "version": 1,
//   "updated_at": <unix-seconds>,
//   "workers": {
//     "<worker-key>": {
//       "first_seen": <unix-seconds>,
//       "last_seen":  <unix-seconds>,
//       "models":     ["..."],       // last-seen aliases
//       "buckets": {
//         "YYYY-MM-DD": {
//           "checks": N,              // total samples that day
//           "ok": N,
//           "suspended": N,
//           "down": N,
//           "lat_sum": <ms>,          // sum of latencies for ok samples
//           "lat_count": N            // number of ok samples (== ok)
//         }
//       }
//     }
//   }
// }
//
// Daily status derivation (consumed by build-site.mjs):
//   down       if any down sample
//   degraded   if no ok and any suspended (model never woke that day)
//   up         if any ok
//   none       otherwise

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HISTORY_DIR = join(ROOT, "history");
const STATE_FILE = join(HISTORY_DIR, "models-state.json");
const ENDPOINT =
  process.env.HEALTH_ENDPOINT || "https://api.empiriolabs.ai/health";
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 90);
const FETCH_TIMEOUT_MS = 15000;

function utcDay(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { version: 1, updated_at: 0, workers: {} };
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object") throw new Error("not an object");
    s.workers = s.workers || {};
    return s;
  } catch (err) {
    console.error(`[record-models] state file unreadable, starting fresh: ${err.message}`);
    return { version: 1, updated_at: 0, workers: {} };
  }
}

function saveState(state) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  // Stable key ordering for clean diffs
  const out = {
    version: 1,
    updated_at: state.updated_at,
    workers: {},
  };
  for (const key of Object.keys(state.workers).sort()) {
    const w = state.workers[key];
    const buckets = {};
    for (const day of Object.keys(w.buckets || {}).sort()) {
      buckets[day] = w.buckets[day];
    }
    out.workers[key] = {
      first_seen: w.first_seen,
      last_seen: w.last_seen,
      models: w.models || [],
      buckets,
    };
  }
  writeFileSync(STATE_FILE, JSON.stringify(out, null, 2) + "\n");
}

function trimBuckets(workerEntry, todayUnix) {
  const cutoff = new Date((todayUnix - (HISTORY_DAYS - 1) * 86400) * 1000);
  const cutoffDay = utcDay(Math.floor(cutoff.getTime() / 1000));
  const buckets = workerEntry.buckets || {};
  for (const day of Object.keys(buckets)) {
    if (day < cutoffDay) delete buckets[day];
  }
  workerEntry.buckets = buckets;
}

async function fetchHealth() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      signal: ctrl.signal,
      headers: { "user-agent": "empiriolabs-status-recorder/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function recordSample(state, data, nowUnix) {
  const workers = data.workers || {};
  const day = utcDay(nowUnix);
  const seen = new Set();

  for (const [key, w] of Object.entries(workers)) {
    seen.add(key);
    const status =
      w.status === "ok" || w.status === "suspended" || w.status === "down"
        ? w.status
        : "down";
    const lat =
      typeof w.latency_ms === "number" && isFinite(w.latency_ms)
        ? w.latency_ms
        : null;

    if (!state.workers[key]) {
      state.workers[key] = {
        first_seen: nowUnix,
        last_seen: nowUnix,
        models: Array.isArray(w.models) ? w.models : [],
        buckets: {},
      };
    }
    const entry = state.workers[key];
    entry.last_seen = nowUnix;
    if (Array.isArray(w.models) && w.models.length) entry.models = w.models;

    if (!entry.buckets[day]) {
      entry.buckets[day] = {
        checks: 0,
        ok: 0,
        suspended: 0,
        down: 0,
        lat_sum: 0,
        lat_count: 0,
      };
    }
    const b = entry.buckets[day];
    b.checks += 1;
    b[status] = (b[status] || 0) + 1;
    if (status === "ok" && lat != null) {
      b.lat_sum += lat;
      b.lat_count += 1;
    }
    trimBuckets(entry, nowUnix);
  }

  // Workers we previously tracked but didn't see this run remain in state
  // so their historical bars persist for HISTORY_DAYS. They naturally stop
  // accumulating new buckets and will be evicted from the UI if their last
  // bucket falls outside the window.
  state.updated_at = nowUnix;
  return seen.size;
}

async function main() {
  const data = await fetchHealth();
  const checkedAt = typeof data.checked_at === "number" ? data.checked_at : null;
  const nowUnix = checkedAt ?? Math.floor(Date.now() / 1000);
  const state = loadState();
  const recorded = recordSample(state, data, nowUnix);
  saveState(state);
  console.log(
    `[record-models] recorded ${recorded} workers @ ${utcDay(nowUnix)} (${nowUnix})`
  );
}

main().catch((err) => {
  console.error(`[record-models] FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
