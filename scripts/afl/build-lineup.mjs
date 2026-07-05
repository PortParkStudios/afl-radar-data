#!/usr/bin/env node
// ---------------------------------------------------------------------------
// lineup_raw.csv (one row per named player) -> lineups.json, keyed by
// `round-homeId-awayId` (internal team ids, matching teams.ts / Squiggle ids).
//
//   node scripts/afl/build-lineup.mjs [--in scripts/afl/lineup_raw.csv] [--out lineups.json]
//
// Zero npm deps, same house style as build-players.mjs / build-worm.mjs.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const IN = getArg('in', 'scripts/afl/lineup_raw.csv');
const OUT = getArg('out', 'lineups.json');

// Team name -> internal id (matches teams.ts / Squiggle). Duplicated on purpose
// so this stays a standalone, dependency-free script.
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

// AFL position code -> team-sheet line label. Unknown codes fall through to
// substring detection so no player is ever dropped.
function lineOf(pos) {
  const p = String(pos ?? '').toUpperCase();
  if (['FB', 'BPL', 'BPR'].includes(p)) return 'Backs';
  if (['CHB', 'HBFL', 'HBFR'].includes(p)) return 'Half backs';
  if (['C', 'WL', 'WR'].includes(p)) return 'Centre';
  if (['CHF', 'HFFL', 'HFFR'].includes(p)) return 'Half forwards';
  if (['FF', 'FPL', 'FPR'].includes(p)) return 'Forwards';
  if (['RK', 'RR', 'R', 'RUC', 'RUCK'].includes(p)) return 'Followers';
  if (p.includes('INT') || p === 'IC') return 'Interchange';
  if (p.includes('SUB')) return 'Substitute';
  if (p.includes('EMER')) return 'Emergencies';
  return 'Bench';
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

const truthy = (v) => v === 'TRUE' || v === 'true' || v === '1';
const clean = (v) => (v && v !== 'NA' ? v : undefined);

const rows = parseCSV(readFileSync(IN, 'utf8'));
if (rows.length === 0) {
  console.error(`No rows in ${IN}.`);
  process.exit(1);
}

// Group rows by match.
const byMatch = new Map();
for (const r of rows) {
  if (!byMatch.has(r.providerId)) byMatch.set(r.providerId, []);
  byMatch.get(r.providerId).push(r);
}

const teamSide = (id, teamRows) => ({
  id,
  status: teamRows[0]?.teamStatus,
  players: teamRows.map((r) => {
    const p = {
      num: parseInt(r.jumper, 10) || null,
      name: r.surname,
      pos: r.position,
      line: lineOf(r.position),
    };
    if (truthy(r.captain)) p.c = 1;
    const late = clean(r.lateChange);
    if (late) p.late = late;
    return p;
  }),
});

const unmapped = new Set();
const games = {};
for (const [, mrows] of byMatch) {
  const homeRows = mrows.filter((r) => r.teamType === 'home');
  const awayRows = mrows.filter((r) => r.teamType === 'away');
  if (!homeRows.length || !awayRows.length) continue;
  const hId = teamId(homeRows[0].teamName);
  const aId = teamId(awayRows[0].teamName);
  if (!hId) unmapped.add(homeRows[0].teamName);
  if (!aId) unmapped.add(awayRows[0].teamName);
  if (!hId || !aId) continue;
  const round = parseInt(homeRows[0].round, 10);
  games[`${round}-${hId}-${aId}`] = { home: teamSide(hId, homeRows), away: teamSide(aId, awayRows) };
}

writeFileSync(OUT, JSON.stringify({ season: new Date().getFullYear(), games }));
console.log(`Wrote ${Object.keys(games).length} match lineup(s) to ${OUT}`);
if (unmapped.size) console.warn(`⚠ Unmapped team names (skipped): ${[...unmapped].join(' | ')}`);
