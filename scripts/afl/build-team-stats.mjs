#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Compute TRUE team per-game averages from the raw match-level rows (every
// player, no min-games filter — unlike the player dataset). Emits a bundled TS
// module the app reads directly, so team stats reconcile with real scoring.
//
//   node scripts/afl/build-team-stats.mjs [--in scripts/afl/afl_raw.csv]
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};

const IN = 'scripts/afl/afl_raw.csv';
const OUT = 'src/data/seed/teamStats.ts';

const METRICS = [
  'disposals', 'kicks', 'handballs', 'marks', 'contestedPossessions',
  'uncontestedPossessions', 'clearances', 'tackles', 'inside50s', 'rebound50s',
  'goals', 'behinds', 'scoreInvolvements', 'metresGained', 'hitouts',
  'intercepts', 'marksInside50', 'groundBallGets', 'disposalEfficiency',
];
const SIMPLE = {
  disposals: 'disposals', kicks: 'kicks', handballs: 'handballs', marks: 'marks',
  contestedPossessions: 'contestedPossessions', uncontestedPossessions: 'uncontestedPossessions',
  tackles: 'tackles', inside50s: 'inside50s', rebound50s: 'rebound50s', goals: 'goals',
  behinds: 'behinds', scoreInvolvements: 'scoreInvolvements', metresGained: 'metresGained',
  hitouts: 'hitouts', intercepts: 'intercepts', marksInside50: 'marksInside50',
  groundBallGets: 'extendedStats.groundBallGets',
};

const TEAM_MATCH = [
  ['north melbourne', '12'], ['kangaroos', '12'], ['greater western sydney', '9'], ['gws', '9'],
  ['port adelaide', '13'], ['west coast', '17'], ['gold coast', '8'], ['western bulldogs', '18'],
  ['footscray', '18'], ['st kilda', '15'], ['brisbane', '2'], ['adelaide', '1'], ['sydney', '16'],
  ['melbourne', '11'], ['carlton', '3'], ['collingwood', '4'], ['essendon', '5'], ['fremantle', '6'],
  ['geelong', '7'], ['hawthorn', '10'], ['richmond', '14'],
];
const teamId = (name) => {
  const n = String(name ?? '').trim().toLowerCase();
  for (const [t, id] of TEAM_MATCH) if (n.includes(t)) return id;
  return null;
};
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const seasonOf = (row) => {
  const s = String(row['compSeason.shortName'] ?? '').match(/(\d{4})/);
  if (s) return Number(s[1]);
  const u = String(row['utcStartTime'] ?? '').match(/(\d{4})/);
  return u ? Number(u[1]) : null;
};
const clearancesOf = (row) => {
  const t = row['clearances.totalClearances'];
  if (t != null && t !== '') return num(t);
  return num(row['clearances.centreClearances']) + num(row['clearances.stoppageClearances']);
};
const deOf = (row) => { const v = num(row['disposalEfficiency']); return v <= 1 ? v * 100 : v; };
const valueOf = (row, m) => (m === 'clearances' ? clearancesOf(row) : m === 'disposalEfficiency' ? deOf(row) : num(row[SIMPLE[m]]));

function parseCSV(text) {
  const rows = [];
  let field = '', record = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c; }
    else if (c === '"') inQuotes = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n') { record.push(field); rows.push(record); record = []; field = ''; }
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field.length || record.length) { record.push(field); rows.push(record); }
  const header = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const rows = parseCSV(readFileSync(IN, 'utf8'));
const groups = new Map(); // `${season}|${tid}` -> { rounds:Set, sums:{}, deNum, deDen }
const perRound = new Map(); // `${season}|${tid}|${round}` -> { clr, cp, i50 } (for opponent diffs)
for (const row of rows) {
  const season = seasonOf(row);
  const tid = teamId(row['team.name']);
  if (!season || !tid) continue;
  const key = `${season}|${tid}`;
  let g = groups.get(key);
  if (!g) { g = { season, tid, rounds: new Set(), sums: {}, deNum: 0, deDen: 0 }; groups.set(key, g); }
  g.rounds.add(String(row['round.roundNumber']));
  for (const m of METRICS) { if (m !== 'disposalEfficiency') g.sums[m] = (g.sums[m] ?? 0) + valueOf(row, m); }
  const disp = num(row['disposals']);
  g.deNum += deOf(row) * disp;
  g.deDen += disp;

  const rKey = `${season}|${tid}|${Number(row['round.roundNumber'])}`;
  let pr = perRound.get(rKey);
  if (!pr) { pr = { clr: 0, cp: 0, i50: 0 }; perRound.set(rKey, pr); }
  pr.clr += clearancesOf(row);
  pr.cp += num(row['contestedPossessions']);
  pr.i50 += num(row['inside50s']);
}

const round1 = (x) => Math.round(x * 10) / 10;
const stats = {}; // season -> tid -> {metric: perGame}
const games = {}; // season -> tid -> gamesPlayed
for (const g of groups.values()) {
  const n = g.rounds.size || 1;
  (stats[g.season] ??= {})[g.tid] = {};
  for (const m of METRICS) {
    if (m === 'disposalEfficiency') stats[g.season][g.tid][m] = round1(g.deDen > 0 ? g.deNum / g.deDen : 0);
    else stats[g.season][g.tid][m] = round1((g.sums[m] ?? 0) / n);
  }
  (games[g.season] ??= {})[g.tid] = n;
}

const seasons = Object.keys(stats).map(Number).sort((a, b) => a - b);

// Player box scores miss RUSHED behinds (not credited to any player), so team
// goals/behinds summed from players undercount the real team score. Override
// them with the official per-game goals/behinds from Squiggle's games feed
// (hgoals/hbehinds/agoals/abehinds), which include rushed behinds.
const teamMatches = {}; // tid -> [{ s, r, pf, pa, date }] (chronological, filled below)
const teamLadder = {}; // tid -> [{ s, rank, wp }] (final ladder per season)
const UA = { 'User-Agent': 'Footy Stats/1.0', Accept: 'application/json' };
async function applyOfficialScores() {
  for (const yr of seasons) {
    // Final ladder for the season (rank + win%) for the trajectory chart.
    try {
      const lres = await fetch(`https://api.squiggle.com.au/?q=standings;year=${yr}`, { headers: UA });
      if (lres.ok) {
        for (const r of JSON.parse(await lres.text()).standings ?? []) {
          (teamLadder[String(r.id)] ??= []).push({
            s: yr,
            rank: r.rank,
            wp: r.played > 0 ? Math.round((r.wins / r.played) * 1000) / 1000 : 0,
          });
        }
      }
    } catch {
      /* standings unavailable for this season */
    }

    try {
      const res = await fetch(`https://api.squiggle.com.au/?q=games;year=${yr}`, {
        headers: UA,
      });
      if (!res.ok) { console.log(`  ${yr}: squiggle ${res.status} — kept box-score scores`); continue; }
      const data = JSON.parse(await res.text());
      const agg = {}; // tid -> { g, b, n }
      for (const gm of data.games ?? []) {
        if (gm.complete !== 100) continue;
        const add = (tid, g, b) => { (agg[tid] ??= { g: 0, b: 0, n: 0 }); agg[tid].g += g || 0; agg[tid].b += b || 0; agg[tid].n++; };
        add(String(gm.hteamid), gm.hgoals, gm.hbehinds);
        add(String(gm.ateamid), gm.agoals, gm.abehinds);
        // h = 1 when this team was the HOME side of that historical match.
        const push = (tid, opp, pf, pa, h) => { (teamMatches[tid] ??= []).push({ s: yr, r: Number(gm.round) || 0, pf, pa, opp, h, date: gm.date }); };
        push(String(gm.hteamid), String(gm.ateamid), gm.hscore ?? 0, gm.ascore ?? 0, 1);
        push(String(gm.ateamid), String(gm.hteamid), gm.ascore ?? 0, gm.hscore ?? 0, 0);
      }
      let applied = 0;
      for (const [tid, o] of Object.entries(agg)) {
        if (o.n > 0 && stats[yr]?.[tid]) {
          stats[yr][tid].goals = round1(o.g / o.n);
          stats[yr][tid].behinds = round1(o.b / o.n);
          applied++;
        }
      }
      console.log(`  ${yr}: official goals/behinds applied to ${applied} teams`);
    } catch (e) {
      console.log(`  ${yr}: squiggle fetch failed (${e.message}) — kept box-score scores`);
    }
  }

  // Emit per-team match history (points for/against, chronological across seasons).
  const clean = {};
  for (const [tid, arr] of Object.entries(teamMatches)) {
    arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    clean[tid] = arr.map((m) => ({ s: m.s, r: m.r, pf: m.pf, pa: m.pa, opp: m.opp, h: m.h }));
  }
  writeFileSync(
    'src/data/seed/teamMatches.ts',
    `// AUTO-GENERATED by scripts/afl/build-team-stats.mjs — do not edit by hand.\n` +
      `// Per-team match results (points for/against + opponent id + h=1 if this team\n` +
      `// was the home side), chronological across all seasons.\n` +
      `export interface TeamMatch { s: number; r: number; pf: number; pa: number; opp: string; h: 0 | 1; }\n\n` +
      `export const TEAM_MATCHES: Record<string, TeamMatch[]> = ${JSON.stringify(clean, null, 0)};\n`,
  );
  const anyTid = Object.keys(clean)[0];
  console.log(`Wrote src/data/seed/teamMatches.ts — ${Object.keys(clean).length} teams, e.g. ${anyTid}: ${clean[anyTid]?.length} matches.`);

  for (const arr of Object.values(teamLadder)) arr.sort((a, b) => a.s - b.s);
  writeFileSync(
    'src/data/seed/teamLadder.ts',
    `// AUTO-GENERATED by scripts/afl/build-team-stats.mjs — do not edit by hand.\n` +
      `// Final ladder position (rank) and win% per team per season.\n` +
      `export interface TeamLadderSeason { s: number; rank: number; wp: number; }\n\n` +
      `export const TEAM_LADDER: Record<string, TeamLadderSeason[]> = ${JSON.stringify(teamLadder, null, 0)};\n`,
  );
  console.log(`Wrote src/data/seed/teamLadder.ts — ${Object.keys(teamLadder).length} teams.`);
}

await applyOfficialScores();

// ---------------------------------------------------------------------------
// Differentials & efficiency: pair each match with the opponent's box-score
// sums (opponent id comes from the Squiggle fixture) and average per game.
//   clearanceDiff/cpDiff/i50Diff  own − opponent, per game
//   pointsDiff                    points for − against, per game (official scores)
//   ptsPerI50                     points scored per own inside-50 entry
//   oppPtsPerI50                  points conceded per opponent inside-50 entry
// ---------------------------------------------------------------------------
const round2 = (x) => Math.round(x * 100) / 100;
let diffTeams = 0;
for (const [tid, arr] of Object.entries(teamMatches)) {
  const bySeason = {};
  for (const m of arr) (bySeason[m.s] ??= []).push(m);
  for (const [yr, ms] of Object.entries(bySeason)) {
    let n = 0, dClr = 0, dCp = 0, dI50 = 0, ownI50 = 0, oppI50 = 0, pf = 0, pa = 0;
    for (const m of ms) {
      const own = perRound.get(`${yr}|${tid}|${m.r}`);
      const opp = perRound.get(`${yr}|${m.opp}|${m.r}`);
      if (!own || !opp) continue; // match missing from box scores — skip
      n++;
      dClr += own.clr - opp.clr;
      dCp += own.cp - opp.cp;
      dI50 += own.i50 - opp.i50;
      ownI50 += own.i50;
      oppI50 += opp.i50;
      pf += m.pf;
      pa += m.pa;
    }
    const t = stats[yr]?.[tid];
    if (n > 0 && t) {
      t.clearanceDiff = round1(dClr / n);
      t.cpDiff = round1(dCp / n);
      t.i50Diff = round1(dI50 / n);
      t.pointsDiff = round1((pf - pa) / n);
      if (ownI50 > 0) t.ptsPerI50 = round2(pf / ownI50);
      if (oppI50 > 0) t.oppPtsPerI50 = round2(pa / oppI50);
      diffTeams++;
    }
  }
}
console.log(`Differentials computed for ${diffTeams} team-seasons.`);

const body = `// AUTO-GENERATED by scripts/afl/build-team-stats.mjs — do not edit by hand.
// True team per-game averages. Most metrics are summed from the raw match-level
// box scores (every player, no min-games filter); goals & behinds are overridden
// with the OFFICIAL team scores from Squiggle (so rushed behinds are included and
// goals*6+behinds reconciles with real scoring).
import type { MetricKey } from '@/lib/types';

export const TEAM_STATS: Record<number, Record<string, Partial<Record<MetricKey, number>>>> = ${JSON.stringify(stats, null, 0)};

export const TEAM_GAMES: Record<number, Record<string, number>> = ${JSON.stringify(games, null, 0)};
`;
writeFileSync(OUT, body);
console.log(`Wrote ${OUT} — seasons ${seasons.join(', ')}, ${groups.size} team-seasons.`);
const last = seasons[seasons.length - 1];
const c = stats[last]?.['4'];
if (c) console.log(`  Collingwood ${last}: goals ${c.goals}, behinds ${c.behinds}, implied pts/g ${round1(c.goals * 6 + c.behinds)}, disposals ${c.disposals}, games ${games[last]['4']}`);

// Also emit a version-stamped team-stats.json for the app to consume, so the
// current season's team presets stay daily-fresh instead of frozen to the app's
// bundled seed. Version derives from players.json (same scheme as build-weights).
const jsonOut = argv('--json');
if (jsonOut) {
  const playersPath = argv('--players');
  let version = null;
  if (playersPath) {
    const raw = readFileSync(playersPath, 'utf8');
    const doc = JSON.parse(raw);
    version = doc.version ?? createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }
  writeFileSync(jsonOut, JSON.stringify({ version, teamStats: stats, teamGames: games }) + '\n');
  console.log(`Wrote ${jsonOut} — version ${version}, seasons ${seasons.join(', ')}.`);
}
