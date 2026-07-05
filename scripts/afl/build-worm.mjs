#!/usr/bin/env node
// ---------------------------------------------------------------------------
// worm_raw.csv (flat score-progression points) -> worm.json, keyed by
// `round-homeId-awayId` (internal team ids, which match Squiggle team ids and
// teams.ts). The app looks a match up by that key and draws the margin worm.
//
//   node scripts/afl/build-worm.mjs [--in scripts/afl/worm_raw.csv] [--out worm.json]
//
// Zero npm deps (built-in CSV parser), same as build-players.mjs.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const IN = getArg('in', 'scripts/afl/worm_raw.csv');
const OUT = getArg('out', 'worm.json');
// Optional: merge freshly-built (live) worms onto an existing worm.json (path or
// URL), keeping already-final matches. Used by the match-window job.
const MERGE = getArg('merge', null);

// Team name -> internal id (matches teams.ts / Squiggle ids). Duplicated from
// build-players.mjs on purpose so this stays a standalone, dependency-free
// script. Ordered most-specific-first; matched by substring.
const TEAM_MATCH = [
  ['north melbourne', '12'], ['kangaroos', '12'],
  ['greater western sydney', '9'], ['gws', '9'],
  ['port adelaide', '13'], ['west coast', '17'], ['gold coast', '8'],
  ['western bulldogs', '18'], ['footscray', '18'], ['st kilda', '15'],
  ['brisbane', '2'], ['adelaide', '1'], ['sydney', '16'], ['melbourne', '11'],
  ['carlton', '3'], ['collingwood', '4'], ['essendon', '5'], ['fremantle', '6'],
  ['geelong', '7'], ['hawthorn', '10'], ['richmond', '14'],
];
function teamId(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  for (const [token, id] of TEAM_MATCH) if (n.includes(token)) return id;
  return null;
}

function parseCSV(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n') { record.push(field); rows.push(record); record = []; field = ''; }
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field.length || record.length) { record.push(field); rows.push(record); }
  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const rows = parseCSV(readFileSync(IN, 'utf8'));
if (rows.length === 0) {
  console.error(`No rows in ${IN}.`);
  process.exit(1);
}

const unmapped = new Set();
let games = {};
for (const r of rows) {
  const hId = teamId(r.homeName);
  const aId = teamId(r.awayName);
  if (!hId || !aId) {
    if (!hId) unmapped.add(r.homeName);
    if (!aId) unmapped.add(r.awayName);
    continue;
  }
  const round = parseInt(r.round, 10);
  const key = `${round}-${hId}-${aId}`;
  if (!games[key]) {
    games[key] = {
      home: hId,
      away: aId,
      hs: Math.round(num(r.homeScore)),
      as: Math.round(num(r.awayScore)),
      status: r.status,
      // [secondsElapsed, homeMargin, quarter]
      series: [],
    };
  }
  games[key].series.push([Math.round(num(r.secs)), Math.round(num(r.margin)), parseInt(r.quarter, 10) || 1]);
}
for (const k of Object.keys(games)) games[k].series.sort((a, b) => a[0] - b[0]);

// Merge freshly-built worms onto the existing file, so live matches update while
// already-final ones are preserved (fresh keys win on overlap).
if (MERGE) {
  let existing = {};
  try {
    if (/^https?:/i.test(MERGE)) {
      const res = await fetch(MERGE);
      if (res.ok) existing = (await res.json()).games ?? {};
    } else {
      existing = JSON.parse(readFileSync(MERGE, 'utf8')).games ?? {};
    }
  } catch {
    /* no existing file yet — start fresh */
  }
  const fresh = Object.keys(games).length;
  games = { ...existing, ...games };
  console.log(`Merged ${fresh} fresh worm(s) into ${Object.keys(existing).length} existing`);
}

const season = rows.length ? parseInt(rows[0].year, 10) || 0 : 0;
writeFileSync(OUT, JSON.stringify({ season, generated: new Date().toISOString(), games }));
console.log(`Wrote ${Object.keys(games).length} game worm(s) to ${OUT}`);
if (unmapped.size) console.warn(`⚠ Unmapped team names (skipped): ${[...unmapped].join(' | ')}`);
