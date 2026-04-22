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
  const sites = (config.sites || []).map((s) => {
    const slug = s.slug || slugify(s.name);
    const current = readHistoryFile(slug);
    const history = getHistory(slug, HISTORY_DAYS);
    const buckets = bucketByDay(history, HISTORY_DAYS);
    const pct = uptimePercent(buckets);
    return {
      name: s.name,
      url: s.url,
      slug,
      status: current?.status || "unknown",
      code: current?.code || 0,
      responseTime: current?.responseTime || 0,
      lastUpdated: current?.lastUpdated || null,
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

function renderHtml({ config, sites, overall, incidents, generatedAt }) {
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

      const bars = s.history
        .map((b) => {
          const cls =
            b.status === "down"
              ? "bar bar-down"
              : b.status === "degraded"
              ? "bar bar-degraded"
              : b.status === "up"
              ? "bar bar-up"
              : "bar bar-none";
          const tip =
            b.status === "none"
              ? `${b.date}: no data`
              : `${b.date}: ${b.status} · ${b.checks} checks · avg ${b.avgResponseTime} ms`;
          return `<span class="${cls}" title="${escapeHtml(tip)}"></span>`;
        })
        .join("");

      return `
        <div class="service">
          <div class="service-header">
            <div class="service-name">
              <span class="${dotCls}"></span>
              <a href="${escapeHtml(s.url)}" rel="noopener" target="_blank">${escapeHtml(s.name)}</a>
            </div>
            <div class="service-uptime">${fmtPct(s.uptimePercent)} uptime</div>
          </div>
          <div class="bars" aria-label="${HISTORY_DAYS} day uptime history for ${escapeHtml(s.name)}">${bars}</div>
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
  .brand img { height: 32px; width: auto; display: block; }
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
  }
  .bar { display: block; border-radius: 2px; height: 100%; }
  .bar-up { background: #1ed688; }
  .bar-up:hover { background: #36e09a; }
  .bar-degraded { background: #ffb547; }
  .bar-down { background: #ff4d6a; }
  .bar-none { background: #14233f; }

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
      ${logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(title)}" />` : ""}
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

  ${renderIncidentsSection(incidents)}

  <footer>
    <span>Last updated ${escapeHtml(new Date(generatedAt).toUTCString())}</span>
    <span>© EmpirioLabs AI</span>
  </footer>
</div>
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

  const html = renderHtml({ config, sites, overall, incidents, generatedAt });

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
