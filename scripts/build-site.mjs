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

function renderHtml({ config, sites, overall, generatedAt }) {
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
  .brand .name {
    font-weight: 600;
    font-size: 1rem;
    letter-spacing: -0.01em;
    color: #e6edf6;
  }
  .updates {
    display: inline-flex; align-items: center; gap: 8px;
    background: #0a7cff; color: #fff;
    padding: 9px 16px;
    border-radius: 8px;
    font-size: 0.875rem; font-weight: 500;
    border: 1px solid #0a7cff;
    transition: background 120ms ease;
  }
  .updates:hover { background: #2891ff; color: #fff; }

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
      <span class="name">${escapeHtml(title)}</span>
    </div>
    <a class="updates" href="https://github.com/${config.owner}/${config.repo}/issues" rel="noopener">View incidents</a>
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

  <footer>
    <span>Last updated ${escapeHtml(new Date(generatedAt).toUTCString())}</span>
    <span>© EmpirioLabs AI</span>
  </footer>
</div>
</body>
</html>`;
}

function main() {
  const config = loadConfig();
  const sites = buildSitePayload(config);
  const overall = overallStatus(sites);
  const generatedAt = new Date().toISOString();

  const html = renderHtml({ config, sites, overall, generatedAt });

  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "index.html"), html);

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
