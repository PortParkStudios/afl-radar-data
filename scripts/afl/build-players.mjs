#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Transform AFL (official / Champion Data) per-match rows (from fetch_afl.R)
// into the app's Player shape: per-game averages, one row per player+season,
// with a REAL role (from positions) and jumper number. Emits a TS module the
// app imports with zero code changes.
//
//   node scripts/afl/build-players.mjs [--season 2024] [--min-games 8]
//        [--log-seasons 2] [--in scripts/afl/afl_raw.csv]
//        [--out src/data/seed/players.ts]
//
// No npm dependencies — uses a small built-in CSV parser.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';

/* ----------------------------- args ----------------------------- */
const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const IN = getArg('in', 'scripts/afl/afl_raw.csv');
const OUT = getArg('out', 'src/data/seed/players.ts'); // 'none' to skip the TS module
const JSON_OUT = getArg('json', null); // also emit the full dataset as JSON (for hosting)
const SEASON = getArg('season', null); // null => every season in the file
const LATEST_ONLY = argv.includes('--latest-only'); // build only the most recent season
const MIN_GAMES = Number(getArg('min-games', 8));
// Per-match game logs are bulky; keep them only for the N most recent seasons
// (older seasons keep per-game averages, which power radars/leaderboards/career).
const LOG_SEASONS = Number(getArg('log-seasons', 2));
// Merge mode: build the season(s) in the CSV, then splice them into an existing
// players.json (URL or path), keeping all other seasons. Used by the scheduled
// job so it only re-fetches the current season, not the whole history.
const MERGE = getArg('merge', null);
// Pre-2012 basic stats from AFL Tables (fetch_afltables.R). Optional: when the
// CSV is present, its rows are backfilled onto matching persons as `historical`
// season rows. Absent → existing historical rows (if any) are left untouched.
const HIST_IN = getArg('afltables', 'scripts/afl/afltables_season.csv');

/* --------------------- team name -> our team id ------------------ */
// IDs match src/data/seed/teams.ts (and Squiggle team IDs). Ordered
// most-specific-first so "North Melbourne" doesn't match "Melbourne", etc.
// Matched by substring so official names like "Adelaide Crows" still resolve.
const TEAM_MATCH = [
  ['north melbourne', '12'],
  ['kangaroos', '12'],
  ['greater western sydney', '9'],
  ['gws', '9'],
  ['port adelaide', '13'],
  ['west coast', '17'],
  ['gold coast', '8'],
  ['western bulldogs', '18'],
  ['footscray', '18'],
  ['st kilda', '15'],
  ['brisbane', '2'],
  ['adelaide', '1'],
  ['sydney', '16'],
  ['melbourne', '11'],
  ['carlton', '3'],
  ['collingwood', '4'],
  ['essendon', '5'],
  ['fremantle', '6'],
  ['geelong', '7'],
  ['hawthorn', '10'],
  ['richmond', '14'],
];
function teamId(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  for (const [token, id] of TEAM_MATCH) if (n.includes(token)) return id;
  return null;
}

/* ------------------ AFL position code -> our role ---------------- */
const POSITION_ROLE = {
  RK: 'RUCK',
  C: 'MIDFIELDER', R: 'MIDFIELDER', RR: 'MIDFIELDER',
  WL: 'WING', WR: 'WING',
  FB: 'KEY_DEFENDER', CHB: 'KEY_DEFENDER',
  BPL: 'REBOUND_DEFENDER', BPR: 'REBOUND_DEFENDER', HBFL: 'REBOUND_DEFENDER', HBFR: 'REBOUND_DEFENDER',
  FF: 'KEY_FORWARD', CHF: 'KEY_FORWARD',
  FPL: 'SMALL_FORWARD', FPR: 'SMALL_FORWARD', HFFL: 'SMALL_FORWARD', HFFR: 'SMALL_FORWARD',
  // INT / SUB / EMERG carry no positional signal — ignored.
};

/* --------------- AFL column -> our MetricKey --------------------- */
const METRIC_SOURCES = {
  disposals: ['disposals'],
  kicks: ['kicks'],
  handballs: ['handballs'],
  marks: ['marks'],
  contestedPossessions: ['contestedPossessions'],
  uncontestedPossessions: ['uncontestedPossessions'],
  tackles: ['tackles'],
  inside50s: ['inside50s'],
  rebound50s: ['rebound50s'],
  goals: ['goals'],
  behinds: ['behinds'],
  scoreInvolvements: ['scoreInvolvements'],
  metresGained: ['metresGained'],
  hitouts: ['hitouts'],
  intercepts: ['intercepts'],
  marksInside50: ['marksInside50'],
  groundBallGets: ['extendedStats.groundBallGets'],
  // --- Champion Data advanced stats + official AFL Player Rating. Live from the
  // AFL/CD feed (fetch_afl.R keep-list), same per-match counts/units as above.
  // Rate metrics (timeOnGroundPercentage) are averaged, never totalled (NO_TOTAL).
  ratingPoints: ['ratingPoints'],
  contestedMarks: ['contestedMarks'],
  interceptMarks: ['extendedStats.interceptMarks'],
  spoils: ['extendedStats.spoils'],
  onePercenters: ['onePercenters'],
  contestDefOneOnOnes: ['extendedStats.contestDefOneOnOnes'],
  defHalfPressureActs: ['extendedStats.defHalfPressureActs'],
  pressureActs: ['extendedStats.pressureActs'],
  tacklesInside50: ['tacklesInside50'],
  scoreLaunches: ['extendedStats.scoreLaunches'],
  marksOnLead: ['extendedStats.marksOnLead'],
  hitoutsToAdvantage: ['extendedStats.hitoutsToAdvantage'],
  ruckContests: ['extendedStats.ruckContests'],
  effectiveDisposals: ['extendedStats.effectiveDisposals'],
  centreClearances: ['clearances.centreClearances'],
  stoppageClearances: ['clearances.stoppageClearances'],
  goalAssists: ['goalAssists'],
  clangers: ['clangers'],
  turnovers: ['turnovers'],
  timeOnGroundPercentage: ['timeOnGroundPercentage'],
};

/* ------------------------- CSV parser --------------------------- */
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

/* --------------------- season/name/team helpers ----------------- */
function seasonOf(row) {
  const short = row['compSeason.shortName'];
  if (short) {
    const m = String(short).match(/(\d{4})/);
    if (m) return m[1];
  }
  const m = String(row['utcStartTime'] ?? '').match(/(\d{4})/);
  return m ? m[1] : 'unknown';
}
function nameOf(row) {
  const first = row['player.player.player.givenName'] ?? '';
  const last = row['player.player.player.surname'] ?? '';
  return `${first} ${last}`.trim() || 'Unknown';
}
function jumperOf(row) {
  const j = row['player.player.player.playerJumperNumber'] ?? row['player.jumperNumber'];
  const n = parseInt(j, 10);
  return Number.isFinite(n) ? n : undefined;
}
function clearancesOf(row) {
  const total = row['clearances.totalClearances'];
  if (total != null && total !== '') return num(total);
  return num(row['clearances.centreClearances']) + num(row['clearances.stoppageClearances']);
}
function disposalEfficiencyOf(row) {
  const de = row['disposalEfficiency'];
  if (de == null || de === '') return 0;
  const v = num(de);
  return v <= 1 ? v * 100 : v; // handle 0..1 or 0..100 encodings
}

/* ------------------------ role resolution ----------------------- */
// Real role from the player's most-common on-field position across the season;
// falls back to a stat-based guess if they only ever appeared on the bench.
function roleFromPositions(positions, stats) {
  const votes = {};
  for (const p of positions) {
    const role = POSITION_ROLE[p];
    if (role) votes[role] = (votes[role] ?? 0) + 1;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : inferRole(stats);
}
function inferRole(s) {
  if (s.hitouts >= 8) return 'RUCK';
  if (s.goals >= 1.5 && s.marksInside50 >= 1.4) return 'KEY_FORWARD';
  if (s.goals >= 1.0 && s.tackles >= 2.5 && s.disposals < 16) return 'SMALL_FORWARD';
  if (s.intercepts >= 6 && s.marks >= 6 && s.disposals < 18) return 'KEY_DEFENDER';
  if (s.rebound50s >= 3.5 && s.intercepts >= 3.5) return 'REBOUND_DEFENDER';
  if (s.clearances >= 4 || s.contestedPossessions >= 11) return 'MIDFIELDER';
  if (s.disposals >= 20 && s.uncontestedPossessions >= 14) return 'WING';
  return 'MIDFIELDER';
}

/* ----------------------------- main ----------------------------- */
async function loadExisting(src) {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch existing failed: ${res.status}`);
    return res.json();
  }
  return JSON.parse(readFileSync(src, 'utf8'));
}

let raw = '';
try {
  raw = readFileSync(IN, 'utf8');
} catch {
  if (!MERGE) {
    console.error(`Cannot read ${IN}.`);
    process.exit(1);
  }
}
const rows = raw ? parseCSV(raw) : [];
if (rows.length === 0 && !MERGE) {
  console.error(`No rows parsed from ${IN}.`);
  process.exit(1);
}

let roleOverrides = {};
try {
  roleOverrides = JSON.parse(readFileSync('scripts/afl/roles.json', 'utf8'));
} catch {
  /* optional */
}

// Player bios (DOB, height) keyed by providerId — matches the stats playerId.
// We store DOB and let the app compute age (age is date-relative, so a stored
// age would go stale). Optional: omitted if fetch_details.R hasn't been run.
const detailsMap = {};
try {
  for (const r of parseCSV(readFileSync('scripts/afl/afl_details.csv', 'utf8'))) {
    if (r.providerId) {
      const n = (v) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
      detailsMap[r.providerId] = {
        dob: r.dateOfBirth || undefined,
        height: n(r.heightInCm),
        draftYear: n(r.draftYear),
        draftPick: n(r.draftPosition),
        recruitedFrom: r.recruitedFrom && r.recruitedFrom !== 'NA' ? r.recruitedFrom : undefined,
        debutYear: n(r.debutYear),
      };
    }
  }
} catch {
  /* no bios file — dob/height omitted */
}

const seasons = [...new Set(rows.map(seasonOf))].filter((s) => s !== 'unknown').sort();
let seasonsToBuild = SEASON ? [String(SEASON)] : seasons;
if (LATEST_ONLY && seasonsToBuild.length) seasonsToBuild = [seasonsToBuild[seasonsToBuild.length - 1]];
const logSet =
  LOG_SEASONS <= 0
    ? new Set()
    : new Set(seasonsToBuild.map(Number).sort((a, b) => a - b).slice(-LOG_SEASONS).map(String));
console.log(`Seasons in file: ${seasons.join(', ') || '(none detected)'}`);
console.log(`Building season(s): ${seasonsToBuild.join(', ')}`);
console.log(`Game logs kept for: ${[...logSet].join(', ')}`);

const warnMissing = new Set();
const unmappedTeams = new Set();
const round1 = (x) => Math.round(x * 10) / 10;
const fmt = (k, v) => (k === 'metresGained' ? Math.round(v) : round1(v));

// Rate/percentage metrics have no meaningful whole-season total — skip them
// when capturing totals (their season "sum" would be nonsense).
const NO_TOTAL = new Set([
  'disposalEfficiency', 'goalAccuracy', 'contestedRate', 'kickToHandball',
  'timeOnGroundPercentage', // a per-game % — a season "sum" is meaningless
]);

const matchStats = (g) => {
  const s = {};
  for (const [metric, cols] of Object.entries(METRIC_SOURCES)) {
    const col = cols.find((c) => c in g);
    if (!col) warnMissing.add(metric);
    s[metric] = fmt(metric, num(col ? g[col] : 0));
  }
  s.clearances = fmt('clearances', clearancesOf(g));
  s.disposalEfficiency = fmt('disposalEfficiency', disposalEfficiencyOf(g));
  return s;
};

let players = [];

for (const season of seasonsToBuild) {
  const byPlayer = new Map();
  for (const row of rows) {
    if (seasonOf(row) !== String(season)) continue;
    const id = row['player.player.player.playerId'] || nameOf(row);
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push(row);
  }

  let built = 0;
  for (const [id, games] of byPlayer) {
    if (games.length < MIN_GAMES) continue;
    const first = games[0];
    const tId = teamId(first['team.name']);
    if (!tId) {
      unmappedTeams.add(first['team.name']);
      continue;
    }

    const sum = {};
    const gameLog = [];
    const positions = [];
    let jumper;
    for (const g of games) {
      const s = matchStats(g);
      for (const [k, v] of Object.entries(s)) sum[k] = (sum[k] ?? 0) + v;
      const pos = g['player.player.position'];
      // Per-game on-field position (player_position) alongside the stat line.
      gameLog.push({ round: Number(g['round.roundNumber'] ?? gameLog.length + 1), stats: s, ...(pos ? { pos } : {}) });
      if (pos) positions.push(pos);
      if (jumper == null) jumper = jumperOf(g);
    }
    gameLog.sort((a, b) => a.round - b.round);

    const n = games.length;
    const stats = {};
    const totals = {};
    for (const k of Object.keys(sum)) {
      stats[k] = fmt(k, sum[k] / n);
      // The running sum IS the exact season total (per-match counts are whole).
      if (!NO_TOTAL.has(k)) totals[k] = Math.round(sum[k]);
    }

    const player = {
      id: `afl-${id}-${season}`,
      personId: `afl-${id}`,
      name: nameOf(first),
      teamId: tId,
      role: roleOverrides[id] ?? roleFromPositions(positions, stats),
      season: Number(season),
      number: jumper,
      games: n,
      stats,
      totals,
    };
    const bio = detailsMap[id];
    if (bio?.dob) player.dob = bio.dob;
    if (bio?.height) player.height = bio.height;
    if (bio?.draftYear) player.draftYear = bio.draftYear;
    if (bio?.draftPick) player.draftPick = bio.draftPick;
    if (bio?.recruitedFrom) player.recruitedFrom = bio.recruitedFrom;
    if (bio?.debutYear) player.debutYear = bio.debutYear;
    if (logSet.has(season)) player.gameLog = gameLog;
    players.push(player);
    built++;
  }
  console.log(`  ${season}: ${built} players`);
}

const bySeasonThenDisposals = (a, b) =>
  a.season - b.season || (b.stats.disposals ?? 0) - (a.stats.disposals ?? 0);
players.sort(bySeasonThenDisposals);

// Merge freshly-built season(s) into an existing dataset, replacing only those
// seasons and keeping the rest. Prunes game logs to the LOG_SEASONS most recent.
if (MERGE) {
  const existing = await loadExisting(MERGE);
  const newSeasons = new Set(players.map((p) => p.season));
  const kept = (existing.players || []).filter((p) => !newSeasons.has(p.season));
  const freshCount = players.length;
  players = [...kept, ...players];

  const allSeasons = [...new Set(players.map((p) => p.season))].sort((a, b) => a - b);
  const keepLogs = new Set(LOG_SEASONS <= 0 ? [] : allSeasons.slice(-LOG_SEASONS));
  for (const p of players) if (p.gameLog && !keepLogs.has(p.season)) delete p.gameLog;

  players.sort(bySeasonThenDisposals);
  console.log(
    `Merged ${freshCount} fresh row(s) for season(s) ${[...newSeasons].join(', ')} into ${kept.length} kept → ${players.length} total`
  );
}

/* ----------- historical backfill (AFL Tables, pre-Champion-Data) ----------- */
// Merge basic pre-2012 season rows onto persons already in the dataset, matched
// by name (+ DOB when both sides have it). Only seasons that predate a person's
// earliest Champion Data season are added, and only their BASIC stats — these
// rows are flagged `historical` so the app keeps them off every radar/pool.
function loadAfltables() {
  try {
    return parseCSV(readFileSync(HIST_IN, 'utf8'));
  } catch {
    return null;
  }
}
const histRows = loadAfltables();
if (histRows && histRows.length) {
  const HIST_BASIC = ['disposals', 'kicks', 'handballs', 'marks', 'tackles', 'goals', 'behinds', 'hitouts'];
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const cell = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // Re-derive from scratch each run: drop any previously-built historical rows.
  players = players.filter((p) => !p.historical);

  // One record per person: their role, earliest CD season, dob, team, name.
  const persons = new Map();
  for (const p of players) {
    const pid = p.personId ?? p.id;
    const cur = persons.get(pid);
    if (!cur || p.season < cur.firstSeason) {
      persons.set(pid, { role: p.role, firstSeason: p.season, dob: p.dob, teamId: p.teamId, name: p.name });
    }
  }
  // Indexes for matching: dob+name (precise) and name → set of personIds.
  const byDobName = new Map();
  const byName = new Map();
  for (const [pid, info] of persons) {
    const nk = norm(info.name);
    if (info.dob) byDobName.set(`${info.dob}|${nk}`, pid);
    if (!byName.has(nk)) byName.set(nk, new Set());
    byName.get(nk).add(pid);
  }

  let added = 0;
  let ambiguous = 0;
  let unmatched = 0;
  let droppedTotals = 0;
  for (const r of histRows) {
    const season = parseInt(r.season, 10);
    if (!Number.isFinite(season)) continue;
    const nk = norm(`${r.firstName} ${r.surname}`);
    const dob = r.dob && r.dob !== 'NA' ? r.dob : undefined;

    let pid = dob ? byDobName.get(`${dob}|${nk}`) : undefined;
    if (!pid) {
      const set = byName.get(nk);
      if (set && set.size === 1) pid = [...set][0];
      else if (set && set.size > 1) {
        ambiguous++; // same name, can't disambiguate without DOB — skip
        continue;
      }
    }
    if (!pid) {
      unmatched++; // player never played in the Champion Data era — out of scope
      continue;
    }

    const info = persons.get(pid);
    if (season >= info.firstSeason) continue; // CD already covers this season

    const games = cell(r.games) ?? 0;
    const stats = {};
    const totals = {};
    for (const k of HIST_BASIC) {
      const v = cell(r[k]);
      if (v !== undefined) stats[k] = round1(v);
      // Exact season total from the AFL Tables sum column (added by the R step);
      // omitted when using an older CSV without *_tot columns.
      const t = cell(r[`${k}_tot`]);
      if (t === undefined) continue;
      // Sanity guard: a real total is ~ avg × games. If it's wildly off (a past
      // pipeline bug wrote round(avg) into the *_tot column), drop it so the app
      // falls back to avg×games instead of showing a bogus figure.
      const expected = (stats[k] ?? 0) * games;
      if (games <= 1 || Math.abs(t - expected) <= Math.max(2, 0.15 * expected)) {
        totals[k] = Math.round(t);
      } else {
        droppedTotals++;
      }
    }
    if (Object.keys(stats).length === 0) continue;

    players.push({
      id: `aflt-${pid}-${season}`,
      personId: pid,
      name: info.name,
      teamId: teamId(r.team) ?? info.teamId,
      role: info.role, // carried from CD; historical rows never build a radar
      season,
      games,
      stats,
      ...(Object.keys(totals).length ? { totals } : {}),
      historical: true,
    });
    added++;
  }
  players.sort(bySeasonThenDisposals);
  if (droppedTotals > 0) {
    console.warn(
      `⚠ Historical totals: dropped ${droppedTotals} implausible *_tot value(s) ` +
        `(far from avg×games — re-run fetch_afltables.R). App falls back to avg×games for those.`
    );
  }
  console.log(
    `Historical backfill: +${added} pre-2012 rows onto ${persons.size} persons ` +
      `(${ambiguous} ambiguous name-only skipped, ${unmatched} unmatched/out-of-era)`
  );
} else {
  console.log('Historical backfill: no afltables CSV — leaving existing historical rows as-is.');
}

if (warnMissing.size) {
  console.warn(`\n⚠ Metrics with no matching column: ${[...warnMissing].join(', ')}`);
}
if (unmappedTeams.size) {
  console.warn(`⚠ Unmapped team names (players skipped): ${[...unmappedTeams].join(' | ')}`);
}

// Full dataset as JSON — for remote hosting (Model B). Compact (no indent).
if (JSON_OUT) {
  const outSeason = players.length ? Math.max(...players.map((p) => p.season)) : 0;
  writeFileSync(JSON_OUT, JSON.stringify({ season: outSeason, players }));
  console.log(`Wrote ${players.length} player-seasons to ${JSON_OUT} (JSON)`);
}

// TS module (bundled). Emit in ~500-row chunks and concatenate: one giant
// literal trips TS2590 ("union type too complex"); chunks (each typed Player[])
// type-check fine and keep the object-literal form (smaller bundle than a string).
if (OUT !== 'none') {
  const CHUNK = 500;
  const chunks = [];
  for (let i = 0; i < players.length; i += CHUNK) chunks.push(players.slice(i, i + CHUNK));
  const parts = chunks
    .map((c, i) => `const CHUNK_${i}: Player[] = ${JSON.stringify(c, null, 2)};`)
    .join('\n\n');
  const concat = `export const PLAYERS: Player[] = [\n${chunks
    .map((_, i) => `  ...CHUNK_${i},`)
    .join('\n')}\n];`;
  const banner = `// AUTO-GENERATED by scripts/afl/build-players.mjs — do not edit by hand.
// Source: fitzRoy AFL (official/Champion Data), season(s) ${seasonsToBuild.join(', ')}.
`;
  writeFileSync(OUT, `${banner}import type { Player } from '@/lib/types';\n\n${parts}\n\n${concat}\n`);
  console.log(
    `\nWrote ${players.length} player-seasons across ${seasonsToBuild.length} season(s) (≥${MIN_GAMES} games) to ${OUT}`
  );
}
