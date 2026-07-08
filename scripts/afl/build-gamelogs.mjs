#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Per-player-per-game stat lines for EVERY season in afl_raw.csv -> gamelogs.csv,
// one row per player per match. This is the deep history / training export.
//
// players.json keeps per-game `gameLog` for only the 2 most recent seasons (to
// stay app-loadable); this file captures every game back to 2012 — too big for
// the app to load, but ideal as a training dataset (long format, one row/game).
//
//   node scripts/afl/build-gamelogs.mjs [--in scripts/afl/afl_raw.csv]
//        [--out gamelogs.csv] [--merge]
//
// --merge: keep rows for seasons NOT present in the input, so a current-season
// refresh doesn't drop the backfilled history (same pattern as build-players).
//
// Stat keys mirror build-players.mjs EXACTLY, so a column means the same thing
// across players.json, livestats.json and gamelogs.csv. Each row also carries
// match context (matchId, teams, venue, round, kickoff) so a normalised matches
// table can be split off later without a re-pull. Zero npm deps.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const IN = getArg('in', 'scripts/afl/afl_raw.csv');
const OUT = getArg('out', 'gamelogs.csv');
const MERGE = argv.includes('--merge');

/* --------------------- team name -> our team id (mirrors build-players) ------ */
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

/* --------------- AFL column -> our MetricKey (mirrors build-players) --------- */
const METRIC_SOURCES = {
  disposals: ['disposals'], kicks: ['kicks'], handballs: ['handballs'], marks: ['marks'],
  contestedPossessions: ['contestedPossessions'], uncontestedPossessions: ['uncontestedPossessions'],
  tackles: ['tackles'], inside50s: ['inside50s'], rebound50s: ['rebound50s'], goals: ['goals'],
  behinds: ['behinds'], scoreInvolvements: ['scoreInvolvements'], metresGained: ['metresGained'],
  hitouts: ['hitouts'], intercepts: ['intercepts'], marksInside50: ['marksInside50'],
  groundBallGets: ['extendedStats.groundBallGets'],
  ratingPoints: ['ratingPoints'], contestedMarks: ['contestedMarks'],
  interceptMarks: ['extendedStats.interceptMarks'], spoils: ['extendedStats.spoils'],
  onePercenters: ['onePercenters'], contestDefOneOnOnes: ['extendedStats.contestDefOneOnOnes'],
  defHalfPressureActs: ['extendedStats.defHalfPressureActs'], pressureActs: ['extendedStats.pressureActs'],
  tacklesInside50: ['tacklesInside50'], scoreLaunches: ['extendedStats.scoreLaunches'],
  marksOnLead: ['extendedStats.marksOnLead'], hitoutsToAdvantage: ['extendedStats.hitoutsToAdvantage'],
  ruckContests: ['extendedStats.ruckContests'], effectiveDisposals: ['extendedStats.effectiveDisposals'],
  centreClearances: ['clearances.centreClearances'], stoppageClearances: ['clearances.stoppageClearances'],
  goalAssists: ['goalAssists'], clangers: ['clangers'], turnovers: ['turnovers'],
  timeOnGroundPercentage: ['timeOnGroundPercentage'],
  bounces: ['bounces'], dreamTeamPoints: ['dreamTeamPoints'], freesFor: ['freesFor'],
  freesAgainst: ['freesAgainst'], shotsAtGoal: ['shotsAtGoal'],
  centreBounceAttendances: ['extendedStats.centreBounceAttendances'],
  contestDefLosses: ['extendedStats.contestDefLosses'],
  contestDefLossPercentage: ['extendedStats.contestDefLossPercentage'],
  contestOffOneOnOnes: ['extendedStats.contestOffOneOnOnes'],
  contestOffWins: ['extendedStats.contestOffWins'],
  contestOffWinsPercentage: ['extendedStats.contestOffWinsPercentage'],
  effectiveKicks: ['extendedStats.effectiveKicks'], f50GroundBallGets: ['extendedStats.f50GroundBallGets'],
  hitoutToAdvantageRate: ['extendedStats.hitoutToAdvantageRate'],
  hitoutWinPercentage: ['extendedStats.hitoutWinPercentage'],
  kickEfficiency: ['extendedStats.kickEfficiency'], kickins: ['extendedStats.kickins'],
  kickinsPlayon: ['extendedStats.kickinsPlayon'],
};
// Fixed stat-column order (METRIC_SOURCES insertion order + the two derived).
const STAT_KEYS = [...Object.keys(METRIC_SOURCES), 'clearances', 'disposalEfficiency'];
// Context columns emitted before the stats.
const CONTEXT_KEYS = [
  'personId', 'name', 'season', 'round', 'roundName', 'matchId',
  'teamId', 'team', 'opponentId', 'opponent', 'homeAway', 'venue', 'utcStartTime', 'jumper', 'pos',
];

/* ------------------------------ CSV parse/write ----------------------------- */
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
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCSV = (header, records) =>
  [header.join(','), ...records.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n';

/* ---------------------------- value helpers (mirror build-players) ---------- */
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round1 = (x) => Math.round(x * 10) / 10;
const fmt = (k, v) => (k === 'metresGained' ? Math.round(v) : round1(v));
const clearancesOf = (r) => {
  const total = r['clearances.totalClearances'];
  if (total != null && total !== '') return num(total);
  return num(r['clearances.centreClearances']) + num(r['clearances.stoppageClearances']);
};
const disposalEfficiencyOf = (r) => {
  const de = r['disposalEfficiency'];
  if (de == null || de === '') return 0;
  const v = num(de);
  return v <= 1 ? v * 100 : v; // handle 0..1 or 0..100 encodings
};
function seasonOf(row) {
  const short = row['compSeason.shortName'];
  if (short) { const m = String(short).match(/(\d{4})/); if (m) return m[1]; }
  const m = String(row['utcStartTime'] ?? '').match(/(\d{4})/);
  return m ? m[1] : '';
}
const nameOf = (r) =>
  `${r['player.player.player.givenName'] ?? ''} ${r['player.player.player.surname'] ?? ''}`.trim() || 'Unknown';
const jumperOf = (r) => {
  const j = parseInt(r['player.player.player.playerJumperNumber'] ?? r['player.jumperNumber'], 10);
  return Number.isFinite(j) ? j : '';
};

/* --------------------------------- build ------------------------------------ */
const rows = parseCSV(readFileSync(IN, 'utf8'));
if (rows.length === 0) { console.error(`No rows in ${IN}.`); process.exit(1); }

const records = [];
for (const r of rows) {
  const pid = r['player.player.player.playerId'];
  if (!pid) continue;
  const season = seasonOf(r);
  const tId = teamId(r['team.name']);
  const homeId = teamId(r['home.team.name']);
  const awayId = teamId(r['away.team.name']);
  let homeAway = '', opponent = '', opponentId = '';
  if (tId && tId === homeId) { homeAway = 'home'; opponentId = awayId ?? ''; opponent = r['away.team.name'] ?? ''; }
  else if (tId && tId === awayId) { homeAway = 'away'; opponentId = homeId ?? ''; opponent = r['home.team.name'] ?? ''; }

  const rec = {
    personId: `afl-${pid}`,
    name: nameOf(r),
    season,
    round: parseInt(r['round.roundNumber'], 10) || '',
    roundName: r['round.name'] ?? '',
    matchId: r['providerId'] ?? '',
    teamId: tId ?? '',
    team: r['team.name'] ?? '',
    opponentId,
    opponent,
    homeAway,
    venue: r['venue.name'] ?? '',
    utcStartTime: r['utcStartTime'] ?? '',
    jumper: jumperOf(r),
    pos: r['player.player.position'] ?? '',
  };
  for (const [metric, cols] of Object.entries(METRIC_SOURCES)) {
    const col = cols.find((c) => c in r);
    rec[metric] = fmt(metric, num(col ? r[col] : 0));
  }
  rec.clearances = fmt('clearances', clearancesOf(r));
  rec.disposalEfficiency = fmt('disposalEfficiency', disposalEfficiencyOf(r));
  records.push(rec);
}

const HEADER = [...CONTEXT_KEYS, ...STAT_KEYS];

// Merge: keep rows for seasons NOT freshly built (current-season refresh keeps
// the backfilled history). Fresh rows win for the seasons present in the input.
let all = records;
if (MERGE && existsSync(OUT)) {
  const freshSeasons = new Set(records.map((r) => String(r.season)));
  const existing = parseCSV(readFileSync(OUT, 'utf8')).filter((r) => !freshSeasons.has(String(r.season)));
  all = [...existing, ...records];
  console.log(`Merged ${records.length} fresh row(s) for season(s) ${[...freshSeasons].sort().join(', ')} with ${existing.length} kept`);
}

// Deterministic order (append-friendly for git diffs): season, round, matchId, name.
all.sort((a, b) =>
  Number(a.season) - Number(b.season) ||
  (Number(a.round) || 0) - (Number(b.round) || 0) ||
  String(a.matchId).localeCompare(String(b.matchId)) ||
  String(a.personId).localeCompare(String(b.personId)));

writeFileSync(OUT, toCSV(HEADER, all));
const seasons = [...new Set(all.map((r) => r.season))].sort();
console.log(`Wrote ${all.length} player-game rows across ${seasons.length} season(s) (${seasons[0]}–${seasons[seasons.length - 1]}) to ${OUT}`);
