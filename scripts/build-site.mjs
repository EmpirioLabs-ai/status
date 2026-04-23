#!/usr/bin/env node
// Custom Poe-style status page generator.
// Reads .upptimerc.yml + history/*.yml + git log to build a static index.html.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "_site");

const HISTORY_DAYS = 90;

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadConfig() {
  const raw = readFileSync(join(ROOT, ".upptimerc.yml"), "utf8");
  return yaml.load(raw);
}

// Fetch incidents (GitHub issues with the "status" label) at build time.
// Public repo, so no auth needed; if `gh` is available we use it, otherwise
// fall back to plain HTTPS. Returns newest first.
function loadIncidents(owner, repo, label = "status", limit = 25) {
  try {
    const json = execSync(
      `gh issue list --repo ${owner}/${repo} --state all --limit ${limit} --label ${label} --json number,title,state,createdAt,closedAt,body,url,labels`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
    );
    const arr = JSON.parse(json);
    return arr.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state, // OPEN | CLOSED
      createdAt: i.createdAt,
      closedAt: i.closedAt,
      body: i.body || "",
      url: i.url,
    }));
  } catch {
    return [];
  }
}

function readHistoryFile(slug) {
  const p = join(ROOT, "history", `${slug}.yml`);
  if (!existsSync(p)) return null;
  // history files have a trailing comment block; load only the top YAML doc
  const raw = readFileSync(p, "utf8");
  const docs = yaml.loadAll(raw);
  return docs[0];
}

// Get every commit that touched history/<slug>.yml since N days ago,
// returning an array of { date, status, responseTime, code }.
function getHistory(slug, days = HISTORY_DAYS) {
  const file = `history/${slug}.yml`;
  let log;
  try {
    log = execSync(
      `git log --since="${days} days ago" --pretty=format:"%H|%cI" -- "${file}"`,
      { cwd: ROOT, encoding: "utf8" }
    );
  } catch {
    return [];
  }

  const rows = log.trim().split("\n").filter(Boolean);
  const points = [];
  for (const row of rows) {
    const [sha, iso] = row.split("|");
    try {
      const blob = execSync(`git show ${sha}:${file}`, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      const data = yaml.loadAll(blob)[0];
      if (!data) continue;
      points.push({
        date: iso,
        status: data.status || "unknown",
        responseTime: data.responseTime || 0,
        code: data.code || 0,
      });
    } catch {
      // skip
    }
  }
  return points; // newest first
}

// Bucket points into per-day status (worst status wins).
function bucketByDay(points, days = HISTORY_DAYS) {
  const buckets = new Map(); // ymd -> {status, count, responseTimes:[]}
  for (const p of points) {
    const ymd = p.date.slice(0, 10);
    const cur = buckets.get(ymd) || { status: "up", count: 0, responseTimes: [] };
    cur.count += 1;
    cur.responseTimes.push(p.responseTime);
    // priority: down > degraded > up
    if (p.status === "down") cur.status = "down";
    else if (p.status === "degraded" && cur.status !== "down") cur.status = "degraded";
    buckets.set(ymd, cur);
  }

  // Build last `days` days, oldest first
  const result = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const b = buckets.get(ymd);
    if (b) {
      const avg =
        b.responseTimes.reduce((a, c) => a + c, 0) / b.responseTimes.length;
      result.push({
        date: ymd,
        status: b.status,
        checks: b.count,
        avgResponseTime: Math.round(avg),
      });
    } else {
      result.push({ date: ymd, status: "none", checks: 0, avgResponseTime: 0 });
    }
  }
  return result;
}

function uptimePercent(buckets) {
  const measured = buckets.filter((b) => b.status !== "none");
  if (measured.length === 0) return null;
  const upish = measured.filter((b) => b.status !== "down").length;
  return (upish / measured.length) * 100;
}

// ---- Sites state (history/sites-state.json) ----
// Mirrors the models-state.json shape but per-site. Populated by
// scripts/record-sites.mjs on a */5 cron. We prefer this over git-log
// derived history because the upstream upptime-monitor commits very
// unreliably on free-tier cron, leaving most days as "No data".
function readSitesState() {
  const p = join(ROOT, "history", "sites-state.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return {
      sites: raw.sites || {},
      updated_at: raw.updated_at || 0,
    };
  } catch {
    return null;
  }
}

// Convert a single site's recorded buckets into the 90-day bars shape.
// Same renderer contract as modelBuckets / bucketByDay so renderBars works.
function siteBucketsFromState(siteEntry, days = HISTORY_DAYS) {
  const recorded = (siteEntry && siteEntry.buckets) || {};
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const b = recorded[ymd];
    if (!b || !b.checks) {
      out.push({ date: ymd, status: "none", checks: 0, avgResponseTime: 0 });
      continue;
    }
    let status;
    if (b.down > 0 && b.up === 0) status = "down";
    else if (b.down > 0 && b.up > 0) status = "degraded";
    else status = "up";
    const avg = b.lat_count > 0 ? Math.round(b.lat_sum / b.lat_count) : 0;
    out.push({
      date: ymd,
      status,
      checks: b.checks,
      avgResponseTime: avg,
      ok: b.up || 0,
      down: b.down || 0,
    });
  }
  return out;
}

// ---- Models state (history/models-state.json) ----
function readModelsState() {
  const p = join(ROOT, "history", "models-state.json");
  if (!existsSync(p)) return { workers: {}, updated_at: 0 };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return {
      workers: raw.workers || {},
      updated_at: raw.updated_at || 0,
    };
  } catch {
    return { workers: {}, updated_at: 0 };
  }
}

// Convert a single worker's recorded buckets into the 90-day bars shape
// the renderer expects: [{date, status, checks, avgResponseTime}]
function modelBuckets(workerEntry, days = HISTORY_DAYS) {
  const recorded = (workerEntry && workerEntry.buckets) || {};
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const b = recorded[ymd];
    if (!b || !b.checks) {
      out.push({ date: ymd, status: "none", checks: 0, avgResponseTime: 0 });
      continue;
    }
    let status;
    // Day-level rollup, in priority order:
    //   down     — every probe that day failed
    //   degraded — at least one success and at least one failure
    //   up       — worker was reachable (or healthy-but-dormant) all day
    if (b.down > 0 && b.ok === 0) status = "down";
    else if (b.down > 0 && b.ok > 0) status = "degraded";
    else status = "up";
    const avg = b.lat_count > 0 ? Math.round(b.lat_sum / b.lat_count) : 0;
    out.push({
      date: ymd,
      status,
      checks: b.checks,
      avgResponseTime: avg,
      ok: b.ok || 0,
      down: b.down || 0,
    });
  }
  return out;
}

// Generate the inner HTML for a 90-bar history strip (reused by services + models).
function renderBars(buckets, ariaLabel) {
  const inner = buckets
    .map((b) => {
      const cls =
        b.status === "down"
          ? "bar bar-down"
          : b.status === "degraded"
          ? "bar bar-degraded"
          : b.status === "up"
          ? "bar bar-up"
          : "bar bar-none";
      const statusLabel =
        b.status === "up"
          ? "Operational"
          : b.status === "degraded"
          ? "Partial outage"
          : b.status === "down"
          ? "Outage"
          : "No data";
      const dotCls =
        b.status === "up"
          ? "tt-dot tt-dot-up"
          : b.status === "degraded"
          ? "tt-dot tt-dot-degraded"
          : b.status === "down"
          ? "tt-dot tt-dot-down"
          : "tt-dot tt-dot-none";
      // Build a checks/breakdown line.
      let checksLine;
      if (b.status === "none") {
        checksLine = `<div class="tt-row tt-muted">No checks recorded</div>`;
      } else {
        const parts = [];
        if (b.ok) parts.push(`${b.ok} ok`);
        if (b.down) parts.push(`${b.down} failed`);
        const breakdown = parts.length > 1 ? parts.join(" · ") : null;
        const latLine =
          b.avgResponseTime > 0
            ? `<div class="tt-row"><span class="tt-key">Avg response</span><span class="tt-val">${b.avgResponseTime} ms</span></div>`
            : "";
        checksLine = `<div class="tt-row"><span class="tt-key">Checks</span><span class="tt-val">${b.checks}</span></div>
             ${
               breakdown
                 ? `<div class="tt-row tt-muted"><span class="tt-key">Breakdown</span><span class="tt-val">${breakdown}</span></div>`
                 : ""
             }
             ${latLine}`;
      }
      const tip = `
        <span class="bar-tip" role="tooltip">
          <span class="tt-date">${escapeHtml(b.date)}</span>
          <span class="tt-status"><span class="${dotCls}"></span>${escapeHtml(statusLabel)}</span>
          ${checksLine}
        </span>`;
      return `<span class="${cls}" tabindex="0">${tip}</span>`;
    })
    .join("");
  return `<div class="bars" aria-label="${escapeHtml(ariaLabel)}">${inner}</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtPct(n) {
  if (n === null) return "—";
  if (n >= 99.995) return "100%";
  return `${n.toFixed(2)}%`;
}

function buildSitePayload(config) {
  const sitesState = readSitesState();
  const sites = (config.sites || []).map((s) => {
    const slug = s.slug || slugify(s.name);
    const stateEntry = sitesState && sitesState.sites[slug];

    let status, code, responseTime, lastUpdated, buckets;
    if (stateEntry) {
      // Prefer the recorder-driven state file: it produces dense, reliable
      // history regardless of how often the upstream upptime-monitor
      // workflow actually fires.
      buckets = siteBucketsFromState(stateEntry, HISTORY_DAYS);
      status = stateEntry.last_status || "unknown";
      code = stateEntry.last_code || 0;
      responseTime = stateEntry.last_latency_ms || 0;
      lastUpdated = stateEntry.last_seen
        ? new Date(stateEntry.last_seen * 1000).toISOString()
        : null;
    } else {
      // Legacy fallback: derive from per-file YAML + git log.
      const current = readHistoryFile(slug);
      const history = getHistory(slug, HISTORY_DAYS);
      buckets = bucketByDay(history, HISTORY_DAYS);
      status = current?.status || "unknown";
      code = current?.code || 0;
      responseTime = current?.responseTime || 0;
      lastUpdated = current?.lastUpdated || null;
    }

    const pct = uptimePercent(buckets);
    return {
      name: s.name,
      url: s.url,
      slug,
      status,
      code,
      responseTime,
      lastUpdated,
      uptimePercent: pct,
      history: buckets,
    };
  });
  return sites;
}

function overallStatus(sites) {
  if (sites.some((s) => s.status === "down")) return "down";
  if (sites.some((s) => s.status === "degraded")) return "degraded";
  if (sites.every((s) => s.status === "up")) return "up";
  return "unknown";
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return "ongoing";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function renderIncidentsSection(incidents) {
  if (!incidents.length) {
    return `
    <section class="card">
      <div class="card-header">
        <span>Past incidents</span>
        <span class="card-range">Last 90 days</span>
      </div>
      <div class="empty">No incidents reported.</div>
    </section>`;
  }
  const items = incidents
    .map((i) => {
      const open = i.state === "OPEN";
      const dur = open
        ? "ongoing"
        : fmtDuration(new Date(i.closedAt) - new Date(i.createdAt));
      const cls = open ? "incident-open" : "incident-resolved";
      const label = open ? "Investigating" : "Resolved";
      return `
        <li class="incident ${cls}">
          <div class="incident-head">
            <span class="incident-tag">${label}</span>
            <span class="incident-title">${escapeHtml(i.title)}</span>
          </div>
          <div class="incident-meta">
            <span>${escapeHtml(fmtDate(i.createdAt))}</span>
            <span>·</span>
            <span>Duration: ${escapeHtml(dur)}</span>
          </div>
        </li>`;
    })
    .join("");
  return `
    <section class="card">
      <div class="card-header">
        <span>Past incidents</span>
        <span class="card-range">Most recent ${incidents.length}</span>
      </div>
      <ul class="incident-list">${items}</ul>
    </section>`;
}

function renderHtml({ config, sites, overall, incidents, generatedAt, modelsState }) {
  const sw = config["status-website"] || {};
  const title = sw.name || "Status";
  const fav = sw.favicon || "";
  const logo = sw.logoUrl || "";

  const banner = (() => {
    if (overall === "up")
      return {
        cls: "banner-up",
        icon: "✓",
        title: "All systems operational",
        body: "We're not aware of any issues affecting our services.",
      };
    if (overall === "degraded")
      return {
        cls: "banner-degraded",
        icon: "!",
        title: "Degraded performance",
        body: "One or more services are experiencing degraded performance.",
      };
    if (overall === "down")
      return {
        cls: "banner-down",
        icon: "✕",
        title: "Service disruption",
        body: "One or more services are currently unavailable.",
      };
    return {
      cls: "banner-unknown",
      icon: "?",
      title: "Status unavailable",
      body: "We don't have recent monitoring data yet.",
    };
  })();

  const monthRange = (() => {
    const now = new Date();
    const past = new Date(now);
    past.setUTCDate(past.getUTCDate() - (HISTORY_DAYS - 1));
    const fmt = (d) =>
      d.toLocaleString("en-US", { month: "short", year: "numeric" });
    return `${fmt(past)} – ${fmt(now)}`;
  })();

  // ---- Server-rendered models tiles (live JS will hydrate the dot/state/detail) ----
  const recordedWorkers = (modelsState && modelsState.workers) || {};
  const sortedWorkerKeys = Object.keys(recordedWorkers).sort((a, b) =>
    a.localeCompare(b)
  );
  const modelsTilesHtml = sortedWorkerKeys
    .map((key) => {
      const w = recordedWorkers[key];
      const buckets = modelBuckets(w, HISTORY_DAYS);
      const pct = uptimePercent(buckets);
      const todays = buckets[buckets.length - 1];
      // Server-rendered initial state is intentionally neutral — the live JS
      // poller hydrates the dot/state/detail with the gateway's current view
      // within ~1s. Showing yesterday's rollup here would mislabel a worker
      // as "Down" or "Idle" when it's actually fine right now.
      const stateClass = "ok";
      const stateLabel = "Checking\u2026";
      const barsHtml = renderBars(buckets, `${HISTORY_DAYS} day history for ${key}`);
      return `
        <div class="worker-tile" data-worker="${escapeHtml(key)}">
          <div class="worker-row ${stateClass}" data-tile-row>
            <span class="worker-dot ${stateClass}" data-tile-dot aria-hidden="true"></span>
            <span class="worker-name">${escapeHtml(key)}</span>
            <span class="worker-state" data-tile-state>${escapeHtml(stateLabel)}</span>
            <span class="worker-detail" data-tile-detail>${
              pct == null ? "" : escapeHtml(fmtPct(pct) + " uptime")
            }</span>
          </div>
          ${barsHtml}
        </div>`;
    })
    .join("");

  const modelsLastUpdatedAttr =
    modelsState && modelsState.updated_at
      ? ` data-recorded-at="${modelsState.updated_at}"`
      : "";

  const sitesHtml = sites
    .map((s) => {
      const dotCls =
        s.status === "down"
          ? "dot dot-down"
          : s.status === "degraded"
          ? "dot dot-degraded"
          : s.status === "up"
          ? "dot dot-up"
          : "dot dot-unknown";

      const barsHtml = renderBars(
        s.history,
        `${HISTORY_DAYS} day uptime history for ${s.name}`
      );

      return `
        <div class="service">
          <div class="service-header">
            <div class="service-name">
              <span class="${dotCls}"></span>
              <a href="${escapeHtml(s.url)}" rel="noopener" target="_blank">${escapeHtml(s.name)}</a>
            </div>
            <div class="service-uptime">${fmtPct(s.uptimePercent)} uptime</div>
          </div>
          ${barsHtml}
          <div class="bars-axis">
            <span>${HISTORY_DAYS} days ago</span>
            <span>Today</span>
          </div>
        </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} Status</title>
<meta name="description" content="Live operational status of EmpirioLabs AI services." />
<meta name="theme-color" content="#000815" />
<meta name="color-scheme" content="dark" />
${fav ? `<link rel="icon" href="${escapeHtml(fav)}" />` : ""}
${sw.appleTouchIcon ? `<link rel="apple-touch-icon" href="${escapeHtml(sw.appleTouchIcon)}" />` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
<style>
  *,*::before,*::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: #000815;
    color: #e6edf6;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    letter-spacing: -0.005em;
  }
  a { color: #4a9bff; text-decoration: none; }
  a:hover { color: #66adff; }

  .page { max-width: 880px; margin: 0 auto; padding: 56px 24px 80px; }

  header.top {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 32px;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand a { display: inline-flex; align-items: center; text-decoration: none; color: inherit; }
  .brand img { height: 44px; width: auto; display: block; }
  .updates {
    display: inline-flex; align-items: center; gap: 8px;
    background: #0a7cff; color: #fff;
    padding: 9px 16px;
    border-radius: 8px;
    font-size: 0.875rem; font-weight: 500;
    border: 1px solid #0a7cff;
    cursor: pointer;
    transition: background 120ms ease;
  }
  .updates:hover { background: #2891ff; color: #fff; }

  /* subscribe popover */
  .sub-wrap { position: relative; }
  .sub-pop {
    display: none;
    position: absolute; right: 0; top: calc(100% + 8px);
    width: 280px;
    background: #060f22;
    border: 1px solid #14233f;
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.45);
    z-index: 10;
  }
  .sub-pop.open { display: block; }
  .sub-pop h4 {
    margin: 0 0 8px;
    font-size: 0.85rem;
    font-weight: 600;
    color: #a8b3c7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .sub-pop a.option {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    color: #e6edf6;
    font-size: 0.9rem;
    border: 1px solid transparent;
    transition: background 120ms, border-color 120ms;
  }
  .sub-pop a.option:hover {
    background: rgba(10,124,255,0.08);
    border-color: #14233f;
    color: #fff;
  }
  .sub-pop a.option .ic {
    width: 18px; height: 18px; flex: 0 0 18px;
    display: inline-flex; align-items: center; justify-content: center;
    color: #4a9bff;
  }
  .sub-pop .hint { color: #6b7790; font-size: 0.78rem; margin-top: 8px; }

  .banner {
    border: 1px solid #14233f;
    border-radius: 12px;
    padding: 18px 20px;
    margin-bottom: 16px;
    background: #060f22;
  }
  .banner-up { background: linear-gradient(180deg, rgba(30,214,136,0.10), rgba(30,214,136,0.04)); border-color: rgba(30,214,136,0.35); }
  .banner-degraded { background: linear-gradient(180deg, rgba(255,181,71,0.10), rgba(255,181,71,0.04)); border-color: rgba(255,181,71,0.35); }
  .banner-down { background: linear-gradient(180deg, rgba(255,77,106,0.12), rgba(255,77,106,0.05)); border-color: rgba(255,77,106,0.4); }
  .banner-unknown { background: #060f22; }
  .banner-row {
    display: flex; align-items: center; gap: 12px;
    font-weight: 600; font-size: 1.05rem;
  }
  .banner-icon {
    width: 22px; height: 22px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 0.8rem; color: #000815;
  }
  .banner-up .banner-icon { background: #1ed688; }
  .banner-degraded .banner-icon { background: #ffb547; }
  .banner-down .banner-icon { background: #ff4d6a; color: #fff; }
  .banner-unknown .banner-icon { background: #4a5568; color: #fff; }
  .banner-body { margin-top: 6px; color: #a8b3c7; font-size: 0.9rem; }

  .card {
    border: 1px solid #14233f;
    border-radius: 12px;
    background: #060f22;
    padding: 20px;
    margin-bottom: 16px;
  }
  .card-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 18px;
    font-weight: 600; font-size: 1rem;
  }
  .card-range {
    color: #6b7790;
    font-size: 0.85rem; font-weight: 500;
  }

  .service { padding: 14px 0; border-bottom: 1px solid #0e1a31; }
  .service:last-child { border-bottom: 0; padding-bottom: 0; }
  .service:first-child { padding-top: 0; }

  .service-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .service-name {
    display: flex; align-items: center; gap: 10px;
    font-weight: 500; font-size: 0.95rem;
  }
  .service-name a { color: #e6edf6; }
  .service-name a:hover { color: #fff; }
  .service-uptime { color: #8a96b0; font-size: 0.85rem; font-variant-numeric: tabular-nums; }

  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .dot-up { background: #1ed688; box-shadow: 0 0 0 3px rgba(30,214,136,0.15); }
  .dot-degraded { background: #ffb547; box-shadow: 0 0 0 3px rgba(255,181,71,0.15); }
  .dot-down { background: #ff4d6a; box-shadow: 0 0 0 3px rgba(255,77,106,0.18); }
  .dot-unknown { background: #4a5568; }

  .bars {
    display: grid;
    grid-template-columns: repeat(${HISTORY_DAYS}, 1fr);
    gap: 2px;
    height: 32px;
    margin-top: 4px;
    /* Allow tooltips to escape vertically */
    overflow: visible;
  }
  .bar {
    display: block;
    border-radius: 2px;
    height: 100%;
    position: relative;
    cursor: pointer;
    transition: transform 160ms cubic-bezier(.2,.8,.2,1),
                filter 160ms ease,
                background-color 160ms ease;
    transform-origin: center;
    will-change: transform;
    outline: none;
  }
  .bar:hover, .bar:focus-visible {
    transform: scaleY(1.18);
    filter: brightness(1.15);
    z-index: 5;
  }
  .bar-up { background: #1ed688; }
  .bar-up:hover, .bar-up:focus-visible {
    background: #36e09a;
    box-shadow: 0 0 12px rgba(30, 214, 136, 0.45);
  }
  .bar-degraded { background: #ffb547; }
  .bar-degraded:hover, .bar-degraded:focus-visible {
    background: #ffc266;
    box-shadow: 0 0 12px rgba(255, 181, 71, 0.45);
  }
  .bar-down { background: #ff4d6a; }
  .bar-down:hover, .bar-down:focus-visible {
    background: #ff6b85;
    box-shadow: 0 0 12px rgba(255, 77, 106, 0.5);
  }
  .bar-none { background: #14233f; }
  .bar-none:hover, .bar-none:focus-visible {
    background: #1c2e51;
  }

  /* Custom tooltip (real HTML, not CSS attr() trick) */
  .bar-tip {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 10px);
    transform: translate(-50%, 4px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 140ms ease, transform 140ms cubic-bezier(.2,.8,.2,1);
    z-index: 50;

    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 180px;
    padding: 10px 12px;
    background: #0a1428;
    color: #e6ecff;
    border: 1px solid #1f2d4a;
    border-radius: 8px;
    font-size: 0.72rem;
    line-height: 1.35;
    font-weight: 500;
    text-align: left;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    white-space: nowrap;
  }
  .bar-tip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    width: 0; height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 6px solid #0a1428;
    filter: drop-shadow(0 1px 0 #1f2d4a);
  }
  .bar:hover .bar-tip,
  .bar:focus-visible .bar-tip {
    opacity: 1;
    transform: translate(-50%, 0);
  }
  .tt-date {
    color: #8a96b3;
    font-size: 0.68rem;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .tt-status {
    display: flex; align-items: center; gap: 6px;
    font-weight: 600; font-size: 0.78rem;
    color: #e6ecff;
    margin-bottom: 2px;
  }
  .tt-dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  }
  .tt-dot-up { background: #1ed688; }
  .tt-dot-degraded { background: #ffb547; }
  .tt-dot-down { background: #ff4d6a; }
  .tt-dot-none { background: #4a5568; }
  .tt-row {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 18px;
    color: #b8c2db;
    font-weight: 400;
  }
  .tt-key { color: #8a96b3; }
  .tt-val { color: #e6ecff; font-variant-numeric: tabular-nums; font-weight: 500; }
  .tt-muted { color: #8a96b3; font-style: italic; }

  /* Edge bars: anchor tooltip to the side so it doesn't clip the card */
  .bars .bar:nth-child(-n+5) .bar-tip { left: 0; transform: translate(0, 4px); }
  .bars .bar:nth-child(-n+5):hover .bar-tip,
  .bars .bar:nth-child(-n+5):focus-visible .bar-tip {
    transform: translate(0, 0);
  }
  .bars .bar:nth-child(-n+5) .bar-tip::after { left: 12px; }
  .bars .bar:nth-last-child(-n+5) .bar-tip { left: auto; right: 0; transform: translate(0, 4px); }
  .bars .bar:nth-last-child(-n+5):hover .bar-tip,
  .bars .bar:nth-last-child(-n+5):focus-visible .bar-tip {
    transform: translate(0, 0);
  }
  .bars .bar:nth-last-child(-n+5) .bar-tip::after { left: auto; right: 12px; transform: none; }

  @media (prefers-reduced-motion: reduce) {
    .bar { transition: none; }
    .bar:hover, .bar:focus-visible { transform: none; }
    .bar-tip { transition: opacity 100ms ease; transform: translate(-50%, 0); }
  }

  .bars-axis {
    display: flex; justify-content: space-between;
    margin-top: 8px;
    color: #5a6680; font-size: 0.72rem;
  }

  footer {
    margin-top: 32px;
    color: #5a6680;
    font-size: 0.8rem;
    display: flex; justify-content: space-between; align-items: center;
    gap: 16px; flex-wrap: wrap;
  }
  footer a { color: #6b7790; }

  /* incidents */
  .incident-list { list-style: none; padding: 0; margin: 0; }
  .incident { padding: 14px 0; border-bottom: 1px solid #0e1a31; }
  .incident:last-child { border-bottom: 0; padding-bottom: 0; }
  .incident:first-child { padding-top: 0; }
  .incident-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
  .incident-tag {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .incident-resolved .incident-tag {
    background: rgba(30,214,136,0.15);
    color: #1ed688;
  }
  .incident-open .incident-tag {
    background: rgba(255,77,106,0.18);
    color: #ff4d6a;
  }
  .incident-title { font-weight: 500; color: #e6edf6; font-size: 0.95rem; }
  .incident-meta { color: #6b7790; font-size: 0.8rem; display: flex; gap: 6px; flex-wrap: wrap; }
  .empty { color: #6b7790; font-size: 0.9rem; padding: 4px 0; }

  /* live workers */
  .workers-meta {
    display: flex; flex-wrap: wrap; gap: 14px;
    color: #a8b3c7; font-size: 0.85rem;
    padding-bottom: 14px;
    border-bottom: 1px solid #0e1a31;
    margin-bottom: 4px;
  }
  .workers-meta strong { color: #e6edf6; font-weight: 600; }
  .workers-meta .sep { color: #2a3a5c; }
  .workers-refresh {
    margin-left: auto;
    background: transparent;
    border: 1px solid #14233f;
    color: #a8b3c7;
    padding: 4px 10px;
    border-radius: 6px;
    font: inherit; font-size: 0.78rem;
    cursor: pointer;
    transition: border-color 120ms ease, color 120ms ease;
  }
  .workers-refresh:hover:not(:disabled) { border-color: #0a7cff; color: #4a9bff; }
  .workers-refresh:disabled { opacity: 0.5; cursor: wait; }
  .workers-grid { display: flex; flex-direction: column; gap: 14px; }
  .worker-tile {
    display: flex; flex-direction: column; gap: 4px;
    padding: 10px 0;
    border-bottom: 1px solid #0e1a31;
  }
  .worker-tile:last-child { border-bottom: 0; padding-bottom: 0; }
  .worker-tile .bars { height: 14px; margin-top: 2px; }
  .models-axis { margin-top: 14px; }
  .worker-row {
    display: grid;
    grid-template-columns: 16px 1fr auto auto;
    align-items: center;
    gap: 12px;
    padding: 0;
    font-size: 0.9rem;
  }
  .worker-dot {
    width: 8px; height: 8px; border-radius: 50%;
    margin-left: 4px;
    box-shadow: 0 0 0 3px rgba(0,0,0,0); transition: box-shadow 160ms ease;
  }
  .worker-dot.ok { background: #1ed688; box-shadow: 0 0 0 3px rgba(30,214,136,0.12); }
  .worker-dot.suspended { background: #5a6680; }
  .worker-dot.down { background: #ff4d6a; box-shadow: 0 0 0 3px rgba(255,77,106,0.18); }
  .worker-name {
    color: #e6edf6; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
  }
  .worker-state {
    font-size: 0.78rem;
    color: #a8b3c7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .worker-row.ok .worker-state { color: #1ed688; }
  .worker-row.suspended .worker-state { color: #6b7790; }
  .worker-row.down .worker-state { color: #ff4d6a; }
  .worker-detail {
    color: #6b7790; font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    text-align: right;
    min-width: 70px;
  }
  .workers-loading, .workers-error {
    color: #6b7790; font-size: 0.85rem; padding: 14px 0; text-align: center;
  }
  .workers-error { color: #ff4d6a; }
  @media (max-width: 520px) {
    .worker-row { grid-template-columns: 16px 1fr auto; }
    .worker-detail { display: none; }
  }

  /* custom right-click context menu */
  .ctx {
    position: fixed;
    z-index: 50;
    min-width: 240px;
    background: #060f22;
    border: 1px solid #14233f;
    border-radius: 10px;
    padding: 6px;
    box-shadow: 0 16px 40px rgba(0,0,0,0.55);
    font-size: 0.875rem;
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
    transition: opacity 90ms ease, transform 90ms ease;
    pointer-events: none;
  }
  .ctx.open {
    opacity: 1;
    transform: translateY(0) scale(1);
    pointer-events: auto;
  }
  .ctx button, .ctx a {
    display: flex; align-items: center; gap: 10px;
    width: 100%;
    background: transparent;
    color: #e6edf6;
    border: 0;
    padding: 9px 10px;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    text-decoration: none;
    transition: background 90ms ease;
  }
  .ctx button:hover, .ctx a:hover {
    background: rgba(10,124,255,0.12);
    color: #fff;
  }
  .ctx .ic {
    width: 16px; height: 16px; flex: 0 0 16px;
    color: #6b7790;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .ctx button:hover .ic, .ctx a:hover .ic { color: #4a9bff; }
  .ctx .sep {
    height: 1px;
    background: #14233f;
    margin: 4px 6px;
  }
  .ctx .kbd {
    margin-left: auto;
    color: #5a6680;
    font-size: 0.72rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .ctx-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(8px);
    background: #060f22;
    color: #e6edf6;
    border: 1px solid #14233f;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 0.85rem;
    box-shadow: 0 12px 32px rgba(0,0,0,0.5);
    opacity: 0;
    pointer-events: none;
    transition: opacity 160ms ease, transform 160ms ease;
    z-index: 60;
  }
  .ctx-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }


  @media (max-width: 600px) {
    .page { padding: 32px 16px 56px; }
    .bars { height: 28px; }
    .bars-axis { font-size: 0.68rem; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="top">
    <div class="brand">
      <a href="/" aria-label="${escapeHtml(title)} status home">
        ${logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(title)}" />` : escapeHtml(title)}
      </a>
    </div>
    <div class="sub-wrap">
      <button class="updates" id="subBtn" type="button" aria-haspopup="true" aria-expanded="false">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        Subscribe to updates
      </button>
      <div class="sub-pop" id="subPop" role="menu">
        <h4>Get notified</h4>
        <a class="option" href="/feed.xml" role="menuitem">
          <span class="ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.18 17.82a2.18 2.18 0 11-4.36 0 2.18 2.18 0 014.36 0zM2 9.27v3.21a8.52 8.52 0 018.52 8.52h3.21A11.73 11.73 0 002 9.27zM2 2.79V6a15 15 0 0115 15h3.21A18.21 18.21 0 002 2.79z"/></svg></span>
          RSS feed
        </a>
        <a class="option" href="https://github.com/${config.owner}/${config.repo}/subscription" target="_blank" rel="noopener" role="menuitem">
          <span class="ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span>
          Watch on GitHub
        </a>
        <div class="hint">Email subscribers can also star the <a href="https://github.com/${config.owner}/${config.repo}" target="_blank" rel="noopener">repo</a> to receive updates.</div>
      </div>
    </div>
  </header>

  <section class="banner ${banner.cls}">
    <div class="banner-row">
      <span class="banner-icon">${banner.icon}</span>
      <span>${escapeHtml(banner.title)}</span>
    </div>
    <div class="banner-body">${escapeHtml(banner.body)}</div>
  </section>

  <section class="card">
    <div class="card-header">
      <span>System status</span>
      <span class="card-range">${escapeHtml(monthRange)}</span>
    </div>
    ${sitesHtml}
  </section>

  <section class="card" id="workersCard"${modelsLastUpdatedAttr}>
    <div class="card-header">
      <span>Models</span>
      <span class="card-range" id="workersUpdated">Loading…</span>
    </div>
    <div class="workers-meta" id="workersMeta" hidden>
      <span><strong id="wmUp">0</strong> operational</span>
      <span class="sep">·</span>
      <span><strong id="wmDown">0</strong> down</span>
      <span class="sep">·</span>
      <span>of <strong id="wmTotal">0</strong> total</span>
      <button type="button" class="workers-refresh" id="wmRefresh" title="Force a fresh probe">Refresh</button>
    </div>
    <div class="workers-grid" id="workersGrid">${
      modelsTilesHtml
        ? modelsTilesHtml
        : '<div class="workers-loading">Fetching live worker status…</div>'
    }</div>
    <div class="bars-axis models-axis">
      <span>${HISTORY_DAYS} days ago</span>
      <span>Today</span>
    </div>
  </section>

  ${renderIncidentsSection(incidents)}

  <footer>
    <span>Last updated ${escapeHtml(new Date(generatedAt).toUTCString())}</span>
    <span>© ${new Date().getUTCFullYear()} EmpirioLabs AI</span>
  </footer>
</div>

<div class="ctx" id="ctx" role="menu" aria-label="Status page actions">
  <button data-act="copy-link" type="button" role="menuitem">
    <span class="ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>
    Copy link
  </button>
  <button data-act="copy-md" type="button" role="menuitem">
    <span class="ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
    Copy as Markdown
  </button>
  <button data-act="copy-status" type="button" role="menuitem">
    <span class="ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></span>
    Copy status as JSON
  </button>
  <div class="sep"></div>
  <button data-act="rss" type="button" role="menuitem">
    <span class="ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6.18 17.82a2.18 2.18 0 11-4.36 0 2.18 2.18 0 014.36 0zM2 9.27v3.21a8.52 8.52 0 018.52 8.52h3.21A11.73 11.73 0 002 9.27zM2 2.79V6a15 15 0 0115 15h3.21A18.21 18.21 0 002 2.79z"/></svg></span>
    Subscribe via RSS
  </button>
  <button data-act="incidents" type="button" role="menuitem">
    <span class="ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
    View past incidents
  </button>
  <div class="sep"></div>
  <button data-act="view-source" type="button" role="menuitem">
    <span class="ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg></span>
    View on GitHub
  </button>
</div>
<div class="ctx-toast" id="ctxToast" aria-live="polite"></div>
<script>
  (function(){
    var btn = document.getElementById('subBtn');
    var pop = document.getElementById('subPop');
    if(!btn||!pop) return;
    function close(){ pop.classList.remove('open'); btn.setAttribute('aria-expanded','false'); }
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var open = pop.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function(e){
      if(!pop.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
  })();

  /* Live Models grid (auto-refreshing every 30s) */
  (function(){
    var grid = document.getElementById('workersGrid');
    var meta = document.getElementById('workersMeta');
    var updated = document.getElementById('workersUpdated');
    var refreshBtn = document.getElementById('wmRefresh');
    if(!grid) return;

    var ENDPOINT = 'https://api.empiriolabs.ai/health';
    var POLL_MS = 30000;
    var pollTimer = null;
    var lastChecked = null;
    var ageTimer = null;

    function esc(s){
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function ageText(iso){
      if(iso == null || iso === '') return '';
      var t;
      if(typeof iso === 'number'){
        // Unix timestamp; gateway returns seconds, but tolerate ms too
        t = iso < 1e12 ? iso * 1000 : iso;
      } else {
        var n = Number(iso);
        if(!isNaN(n) && n > 0){
          t = n < 1e12 ? n * 1000 : n;
        } else {
          t = new Date(iso).getTime();
        }
      }
      if(!t || isNaN(t)) return '';
      var diff = Math.max(0, Date.now() - t);
      var s = Math.floor(diff / 1000);
      if(s < 5) return 'just now';
      if(s < 60) return s + 's ago';
      var m = Math.floor(s / 60);
      if(m < 60) return m + 'm ago';
      var h = Math.floor(m / 60);
      return h + 'h ago';
    }

    function tickAge(){
      if(lastChecked && updated) updated.textContent = 'Updated ' + ageText(lastChecked);
    }

    function attrSelectorEscape(s){
      // CSS attribute selector value escaping
      return String(s).replace(/(['"\\\\])/g, '\\\\$1');
    }

    // Map gateway status → visible status. Suspended/dormant replicas are a
    // platform implementation detail (Fly scale-to-zero) and aren't an
    // availability problem from the API consumer's perspective, so they
    // collapse into 'ok'. On always-on platforms this branch never fires.
    function visibleStatus(raw){
      if(raw === 'down') return 'down';
      return 'ok';
    }

    function tileLiveDetail(st, w){
      if(st === 'ok' && typeof w.latency_ms === 'number') return w.latency_ms + ' ms';
      if(st === 'down') return w.error || 'Unreachable';
      return '';
    }

    function tileTitle(name, w){
      if(Array.isArray(w.models) && w.models.length){
        return 'Models: ' + w.models.join(', ');
      }
      return '';
    }

    function createTile(name, w, st, label){
      // New worker (no historical bars yet) — inserted at sorted position.
      // Render an empty bars strip with the same number of slots as the
      // server-rendered tiles, each carrying its own date tooltip so hover
      // behavior is identical. The recorder workflow will fill in real
      // status as it accumulates samples.
      var el = document.createElement('div');
      el.className = 'worker-tile';
      el.setAttribute('data-worker', name);
      var emptyBars = '';
      // Build YYYY-MM-DD labels for the last N days, oldest first (matches
      // server-rendered ordering: leftmost = N days ago, rightmost = today).
      var todayMs = Date.now();
      for(var i = ${HISTORY_DAYS} - 1; i >= 0; i--){
        var d = new Date(todayMs - i * 86400000);
        var ymd = d.getUTCFullYear() + '-' +
          String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
          String(d.getUTCDate()).padStart(2, '0');
        emptyBars +=
          '<span class="bar bar-none" tabindex="0">' +
            '<span class="bar-tip" role="tooltip">' +
              '<span class="tt-date">' + esc(ymd) + '</span>' +
              '<span class="tt-status"><span class="tt-dot tt-dot-none"></span>No data</span>' +
              '<span class="tt-row tt-muted">No checks recorded</span>' +
            '</span>' +
          '</span>';
      }
      el.innerHTML =
        '<div class="worker-row ' + esc(st) + '" data-tile-row title="' + esc(tileTitle(name, w)) + '">' +
          '<span class="worker-dot ' + esc(st) + '" data-tile-dot aria-hidden="true"></span>' +
          '<span class="worker-name">' + esc(name) + '</span>' +
          '<span class="worker-state" data-tile-state>' + esc(label) + '</span>' +
          '<span class="worker-detail" data-tile-detail>' + esc(tileLiveDetail(st, w)) + '</span>' +
        '</div>' +
        '<div class="bars" aria-label="' + esc(${HISTORY_DAYS} + ' day history for ' + name) + '">' + emptyBars + '</div>';
      return el;
    }

    function applyTile(tile, name, w){
      var st = visibleStatus(w.status);
      var label = st === 'ok' ? 'Operational' : 'Down';
      var row = tile.querySelector('[data-tile-row]');
      var dot = tile.querySelector('[data-tile-dot]');
      var stateEl = tile.querySelector('[data-tile-state]');
      var detailEl = tile.querySelector('[data-tile-detail]');
      if(row){
        row.classList.remove('ok','suspended','down');
        row.classList.add(st);
        row.setAttribute('title', tileTitle(name, w));
      }
      if(dot){
        dot.classList.remove('ok','suspended','down');
        dot.classList.add(st);
      }
      if(stateEl) stateEl.textContent = label;
      if(detailEl) detailEl.textContent = tileLiveDetail(st, w);
    }

    function insertTileSorted(tile, name){
      var existing = grid.querySelectorAll('.worker-tile');
      for(var i = 0; i < existing.length; i++){
        var k = existing[i].getAttribute('data-worker') || '';
        if(name.localeCompare(k) < 0){
          grid.insertBefore(tile, existing[i]);
          return;
        }
      }
      grid.appendChild(tile);
    }

    function render(data){
      var workers = data.workers || {};
      var keys = Object.keys(workers);
      var loader = grid.querySelector('.workers-loading');
      if(loader) loader.remove();
      for(var i = 0; i < keys.length; i++){
        var name = keys[i];
        var w = workers[name] || {};
        var st = visibleStatus(w.status);
        var label = st === 'ok' ? 'Operational' : 'Down';
        var sel = '[data-worker="' + attrSelectorEscape(name) + '"]';
        var tile = grid.querySelector(sel);
        if(tile){
          applyTile(tile, name, w);
        } else {
          tile = createTile(name, w, st, label);
          insertTileSorted(tile, name);
        }
      }
      if(meta) meta.hidden = false;
      // Roll suspended into operational — we don't surface the cold/idle
      // distinction to viewers (it's a platform detail, not an availability
      // signal). Future always-on platforms will return suspended=0 anyway.
      var up = (data.workers_up || 0) + (data.workers_suspended || 0);
      var down = data.workers_down || 0;
      var total = data.workers_total || (up + down);
      var n = function(id, v){ var el = document.getElementById(id); if(el) el.textContent = v; };
      n('wmUp', up); n('wmDown', down); n('wmTotal', total);
      lastChecked = data.checked_at != null ? data.checked_at : Date.now();
      tickAge();
    }

    function showError(msg){
      // Don't wipe historical bars on a transient fetch error — only show
      // an inline notice if no tiles have been rendered at all.
      if(!grid.querySelector('.worker-tile')){
        grid.innerHTML = '<div class="workers-error">' + esc(msg || 'Could not fetch worker status.') + '</div>';
      }
    }

    function load(force){
      if(refreshBtn){ refreshBtn.disabled = true; }
      var url = ENDPOINT + (force ? '?refresh=1' : '');
      var ctrl = ('AbortController' in window) ? new AbortController() : null;
      var timeoutId = ctrl ? setTimeout(function(){ ctrl.abort(); }, 10000) : null;
      fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data){ render(data); })
        .catch(function(e){ showError('Live status unavailable (' + (e && e.message ? e.message : 'error') + ')'); })
        .then(function(){
          if(timeoutId) clearTimeout(timeoutId);
          if(refreshBtn){ refreshBtn.disabled = false; }
        });
    }

    function start(){
      load(false);
      clearInterval(pollTimer);
      pollTimer = setInterval(function(){ load(false); }, POLL_MS);
      clearInterval(ageTimer);
      ageTimer = setInterval(tickAge, 1000);
    }
    function stop(){ clearInterval(pollTimer); clearInterval(ageTimer); }

    document.addEventListener('visibilitychange', function(){
      if(document.hidden) stop(); else start();
    });

    if(refreshBtn){
      refreshBtn.addEventListener('click', function(){ load(true); });
    }

    start();
  })();

  /* Custom right-click context menu (Fern-style) */
  (function(){
    var ctx = document.getElementById('ctx');
    var toast = document.getElementById('ctxToast');
    if(!ctx) return;
    var lastTarget = null;

    function showToast(msg){
      toast.textContent = msg;
      toast.classList.add('show');
      clearTimeout(toast._t);
      toast._t = setTimeout(function(){ toast.classList.remove('show'); }, 1600);
    }

    function close(){ ctx.classList.remove('open'); }

    function open(x, y){
      ctx.style.left = '0px';
      ctx.style.top = '0px';
      ctx.classList.add('open');
      var rect = ctx.getBoundingClientRect();
      var w = rect.width, h = rect.height;
      var maxX = window.innerWidth - w - 8;
      var maxY = window.innerHeight - h - 8;
      ctx.style.left = Math.min(x, maxX) + 'px';
      ctx.style.top = Math.min(y, maxY) + 'px';
    }

    document.addEventListener('contextmenu', function(e){
      // allow native menu inside form fields and links to external resources via shift
      if(e.shiftKey) return;
      var t = e.target;
      if(t && (t.closest('input,textarea,select'))) return;
      e.preventDefault();
      lastTarget = t;
      open(e.clientX, e.clientY);
    });

    document.addEventListener('click', function(e){
      if(!ctx.contains(e.target)) close();
    });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, { passive: true });

    function copy(text, label){
      var done = function(){ showToast(label + ' copied'); };
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(done).catch(function(){
          try{ var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }catch(_){ showToast('Copy failed'); }
        });
      } else {
        try{ var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }catch(_){ showToast('Copy failed'); }
      }
      close();
    }

    ctx.addEventListener('click', function(e){
      var b = e.target.closest('[data-act]');
      if(!b) return;
      var act = b.getAttribute('data-act');
      if(act === 'copy-link'){
        copy(window.location.href, 'Link');
      } else if(act === 'copy-status'){
        fetch('/summary.json').then(function(r){ return r.text(); }).then(function(t){
          copy(t, 'Status JSON');
        }).catch(function(){ showToast('Could not load status'); close(); });
      } else if(act === 'copy-md'){
        var md = '# ${escapeHtml(title)} Status\\n\\nSee live status: ' + window.location.href;
        copy(md, 'Markdown');
      } else if(act === 'view-source'){
        window.open('https://github.com/${config.owner}/${config.repo}', '_blank', 'noopener');
        close();
      } else if(act === 'rss'){
        window.location.href = '/feed.xml';
      } else if(act === 'incidents'){
        window.open('https://github.com/${config.owner}/${config.repo}/issues', '_blank', 'noopener');
        close();
      }
    });
  })();
</script>
</body>
</html>`;
}

function buildAtomFeed({ config, incidents, generatedAt }) {
  const sw = config["status-website"] || {};
  const cname = sw.cname;
  const baseUrl = cname ? `https://${cname}` : `https://${config.owner}.github.io/${config.repo}`;
  const title = `${sw.name || "Status"} Status`;
  const entries = incidents
    .map((i) => {
      const updated = i.closedAt || i.createdAt;
      const summary = i.state === "OPEN" ? "Investigating" : "Resolved";
      return `  <entry>
    <id>${escapeHtml(i.url)}</id>
    <title>${escapeHtml(i.title)}</title>
    <link rel="alternate" href="${escapeHtml(i.url)}" />
    <updated>${escapeHtml(updated)}</updated>
    <published>${escapeHtml(i.createdAt)}</published>
    <summary>${escapeHtml(summary)}</summary>
    <content type="text">${escapeHtml(i.body || summary)}</content>
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeHtml(baseUrl)}/</id>
  <title>${escapeHtml(title)}</title>
  <link rel="self" href="${escapeHtml(baseUrl)}/feed.xml" />
  <link rel="alternate" href="${escapeHtml(baseUrl)}/" />
  <updated>${escapeHtml(generatedAt)}</updated>
  <author><name>${escapeHtml(sw.name || "EmpirioLabs AI")}</name></author>
${entries}
</feed>`;
}

function main() {
  const config = loadConfig();
  const sites = buildSitePayload(config);
  const incidents = loadIncidents(config.owner, config.repo);
  const overall = overallStatus(sites);
  const generatedAt = new Date().toISOString();
  const modelsState = readModelsState();

  const html = renderHtml({ config, sites, overall, incidents, generatedAt, modelsState });

  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "index.html"), html);
  writeFileSync(join(OUT, "feed.xml"), buildAtomFeed({ config, incidents, generatedAt }));

  // CNAME for custom domain
  const cname = (config["status-website"] || {}).cname;
  if (cname) writeFileSync(join(OUT, "CNAME"), cname + "\n");

  // 404 fallback
  writeFileSync(
    join(OUT, "404.html"),
    `<!doctype html><meta charset=utf-8><title>Not found</title><style>body{background:#000815;color:#e6edf6;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}a{color:#4a9bff}</style><div style="text-align:center"><h1 style="font-size:1.5rem;margin:0 0 8px">404</h1><p>Page not found. <a href="/">Back to status</a>.</p></div>`
  );

  // robots
  writeFileSync(join(OUT, "robots.txt"), "User-agent: *\nAllow: /\n");

  // also write a JSON snapshot for badges/integrations
  const snapshot = {
    generatedAt,
    overall,
    sites: sites.map((s) => ({
      name: s.name,
      slug: s.slug,
      url: s.url,
      status: s.status,
      uptimePercent: s.uptimePercent,
      lastUpdated: s.lastUpdated,
    })),
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(snapshot, null, 2));

  console.log(
    `Built site: ${sites.length} services, overall=${overall}, output=${OUT}`
  );
}

main();
