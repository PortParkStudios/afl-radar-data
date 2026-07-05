#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Per-match player stat lines for the LATEST round(s) -> livestats.json, keyed
// by `round-teamId`. Reuses afl_raw.csv (already produced by fetch_afl.R in the
// Action), so it adds NO extra AFL API calls — it just slices the current round
// out of what was already fetched and publishes it for near-live match stats.
//
//   node scripts/afl/build-livestats.mjs [--in scripts/afl/afl_raw.csv]
//        [--out livestats.json] [--rounds 1]
//
// Zero npm deps, same house style as the other build-*.mjs.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const IN = getArg('in', 'scripts/afl/afl_raw.csv');
const OUT = getArg('out', 'livestats.json');
const ROUNDS = Number(getArg('rounds', 1)); // how many of the most recent rounds to include

// team name -> internal id (matches teams.ts / Squiggle). Duplicated on purpose.
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

// AFL column -> our MetricKey (per-match values). Mirrors build-players.mjs —
// same keys map to the same AFL columns, so a stat means the same thing whether
// read from livestats.json (live match lines) or players.json (season/gameLog).
const METRIC_SOURCES = {
  disposals: 'disposals', kicks: 'kicks', handballs: 'handballs', marks: 'marks',
  contestedPossessions: 'contestedPossessions', uncontestedPossessions: 'uncontestedPossessions',
  tackles: 'tackles', inside50s: 'inside50s', rebound50s: 'rebound50s', goals: 'goals',
  behinds: 'behinds', scoreInvolvements: 'scoreInvolvements', metresGained: 'metresGained',
  hitouts: 'hitouts', intercepts: 'intercepts', marksInside50: 'marksInside50',
  groundBallGets: 'extendedStats.groundBallGets',
  // --- Champion Data advanced stats + official AFL Player Rating. Already in
  // afl_raw.csv (fetch_afl.R keep-list); per-match values so they map 1:1.
  ratingPoints: 'ratingPoints', contestedMarks: 'contestedMarks',
  interceptMarks: 'extendedStats.interceptMarks', spoils: 'extendedStats.spoils',
  onePercenters: 'onePercenters', contestDefOneOnOnes: 'extendedStats.contestDefOneOnOnes',
  defHalfPressureActs: 'extendedStats.defHalfPressureActs', pressureActs: 'extendedStats.pressureActs',
  tacklesInside50: 'tacklesInside50', scoreLaunches: 'extendedStats.scoreLaunches',
  marksOnLead: 'extendedStats.marksOnLead', hitoutsToAdvantage: 'extendedStats.hitoutsToAdvantage',
  ruckContests: 'extendedStats.ruckContests', effectiveDisposals: 'extendedStats.effectiveDisposals',
  centreClearances: 'clearances.centreClearances', stoppageClearances: 'clearances.stoppageClearances',
  goalAssists: 'goalAssists', clangers: 'clangers', turnovers: 'turnovers',
  timeOnGroundPercentage: 'timeOnGroundPercentage',
};

function parseCSV(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n') { record.push(field); rows.push(record); record = []; field = ''; }
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field.length || record.length) { record.push(field); rows.push(record); }
  const header = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round1 = (x) => Math.round(x * 10) / 10;
const clearancesOf = (r) => {
  const total = r['clearances.totalClearances'];
  if (total != null && total !== '') return num(total);
  return num(r['clearances.centreClearances']) + num(r['clearances.stoppageClearances']);
};
const nameOf = (r) =>
  `${r['player.player.player.givenName'] ?? ''} ${r['player.player.player.surname'] ?? ''}`.trim() || 'Unknown';
const jumperOf = (r) => {
  const j = parseInt(r['player.player.player.playerJumperNumber'] ?? r['player.jumperNumber'], 10);
  return Number.isFinite(j) ? j : null;
};

const rows = parseCSV(readFileSync(IN, 'utf8'));
if (rows.length === 0) { console.error(`No rows in ${IN}.`); process.exit(1); }

// Latest N rounds present in the file.
const roundNums = [...new Set(rows.map((r) => parseInt(r['round.roundNumber'], 10)).filter(Number.isFinite))].sort((a, b) => a - b);
const keepRounds = new Set(roundNums.slice(-Math.max(1, ROUNDS)));

const teams = {};
for (const r of rows) {
  const round = parseInt(r['round.roundNumber'], 10);
  if (!keepRounds.has(round)) continue;
  const tId = teamId(r['team.name']);
  if (!tId) continue;
  const pid = r['player.player.player.playerId'];
  if (!pid) continue;

  const stats = {};
  for (const [metric, col] of Object.entries(METRIC_SOURCES)) stats[metric] = round1(num(r[col]));
  stats.clearances = round1(clearancesOf(r));

  const key = `${round}-${tId}`;
  if (!teams[key]) teams[key] = [];
  teams[key].push({ pid: `afl-${pid}`, num: jumperOf(r), name: nameOf(r), stats });
}

// Sort each team's lines by disposals desc (best game up top by default).
for (const k of Object.keys(teams)) teams[k].sort((a, b) => (b.stats.disposals ?? 0) - (a.stats.disposals ?? 0));

writeFileSync(OUT, JSON.stringify({ season: new Date().getFullYear(), rounds: [...keepRounds], generated: new Date().toISOString(), teams }));
console.log(`Wrote ${Object.keys(teams).length} team stat line-set(s) for round(s) ${[...keepRounds].join(', ')} to ${OUT}`);
