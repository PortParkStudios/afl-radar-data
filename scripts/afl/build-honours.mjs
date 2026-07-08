#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Match AFL honours CSVs (Brownlow / All-Australian / Rising Star / coaches
// votes) to players and emit honours.json keyed by personId.
//
// Awards data has NO player id/dob — only name + team + season. So we match on
// (surname + first-initial + season + team), resolving varied team formats, and
// fall back to (surname + initial + season) when that's unique. Ambiguous /
// unmatched rows are skipped and counted.
//
//   node scripts/afl/build-honours.mjs [--players players.json] [--out honours.json]
//        [--dir scripts/afl]
//
// Reads the just-built players.json for the player→personId lookup (so historical
// backfilled seasons match their pre-2012 honours too). Zero npm deps.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PLAYERS = getArg('players', 'players.json');
const OUT = getArg('out', 'honours.json');
const DIR = getArg('dir', 'scripts/afl');

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

// Team name/nickname/abbrev → internal id. Alias keys are alpha-only (norm'd).
const TEAM_ALIASES = {
  adelaide: '1', crows: '1', adel: '1', ade: '1',
  brisbane: '2', brisbanelions: '2', lions: '2', bl: '2', bris: '2',
  carlton: '3', blues: '3', carl: '3', car: '3',
  collingwood: '4', magpies: '4', coll: '4', col: '4',
  essendon: '5', bombers: '5', ess: '5',
  fremantle: '6', dockers: '6', fre: '6', frem: '6',
  geelong: '7', geelongcats: '7', cats: '7', geel: '7', gee: '7',
  goldcoast: '8', goldcoastsuns: '8', suns: '8', gc: '8', gcfc: '8', gcs: '8',
  gws: '9', gwsgiants: '9', giants: '9', greaterwesternsydney: '9',
  hawthorn: '10', hawks: '10', haw: '10',
  melbourne: '11', demons: '11', melb: '11', mel: '11',
  northmelbourne: '12', kangaroos: '12', roos: '12', nm: '12', nmfc: '12', north: '12',
  portadelaide: '13', power: '13', port: '13', pa: '13',
  richmond: '14', tigers: '14', rich: '14',
  stkilda: '15', saints: '15', stk: '15', sk: '15',
  sydney: '16', sydneyswans: '16', swans: '16', syd: '16', ss: '16',
  westcoast: '17', westcoasteagles: '17', eagles: '17', wce: '17', wc: '17',
  westernbulldogs: '18', bulldogs: '18', footscray: '18', wb: '18', wbd: '18', dogs: '18',
};
const resolveTeam = (raw) => TEAM_ALIASES[norm(raw)] ?? null;

// Parse a name to { surname, initial } from either "First Last" or "F Last"
// (initial form), stripping "(TEAM)" and a trailing " W" (Brownlow winner mark).
function parseName(raw) {
  const s = String(raw ?? '').replace(/\([^)]*\)/g, '').replace(/\s+W\s*$/, '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { surname: norm(parts[0]), surnameLast: norm(parts[0]), initial: '' };
  const first = parts[0];
  const initial = (first.length === 1 ? first : first[0]).toLowerCase();
  const surnameRaw = parts.slice(1).join(' ');
  const surname = norm(surnameRaw);
  // Last surname segment — lets an abbreviated hyphenated surname (fitzRoy stores
  // "Wanganeen-Milera" as "W-Milera") still match on the shared final segment.
  const segs = surnameRaw.split(/[\s-]+/).filter(Boolean);
  const surnameLast = norm(segs[segs.length - 1] || surnameRaw);
  return { surname, surnameLast, initial };
}

/* ------------------------------ CSV parser ------------------------------ */
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
const readCSV = (name) => {
  const path = `${DIR}/${name}`;
  return existsSync(path) ? parseCSV(readFileSync(path, 'utf8')) : [];
};

/* ---------------------- player → personId lookup ------------------------ */
// Each key maps to candidate [{ pid, games }]. A same-name/same-team/same-season
// clash (e.g. Chad & Corey Warner at Sydney 2024 — both parse to "warner|c|…")
// is resolved to whoever actually played (most games); that's the honoree.
const players = JSON.parse(readFileSync(PLAYERS, 'utf8')).players || [];
const byKey = new Map();
const byLoose = new Map();
const byLast = new Map(); // keyed by the last surname segment (hyphen fallback)
const byLastLoose = new Map();
const addCand = (map, key, cand) => {
  const arr = map.get(key);
  if (!arr) return map.set(key, [cand]);
  const dup = arr.find((c) => c.pid === cand.pid);
  if (dup) dup.games = Math.max(dup.games, cand.games);
  else arr.push(cand);
};
for (const p of players) {
  const nm = parseName(p.name);
  if (!nm) continue;
  const cand = { pid: p.personId ?? p.id, games: p.games ?? 0 };
  addCand(byKey, `${nm.surname}|${nm.initial}|${p.season}|${p.teamId}`, cand);
  addCand(byLoose, `${nm.surname}|${nm.initial}|${p.season}`, cand);
  addCand(byLast, `${nm.surnameLast}|${nm.initial}|${p.season}|${p.teamId}`, cand);
  addCand(byLastLoose, `${nm.surnameLast}|${nm.initial}|${p.season}`, cand);
}

const stats = { matched: 0, resolved: 0, unmatched: 0 };
// On a clash, the honoree is the one with the most games that season.
function pickByGames(arr) {
  if (!arr || arr.length === 0) return null;
  if (arr.length > 1) stats.resolved++;
  return arr.reduce((best, c) => (c.games > best.games ? c : best)).pid;
}
function matchPerson(playerRaw, season, teamRaw) {
  const pn = parseName(playerRaw);
  if (!pn) return null;
  const teamId = resolveTeam(teamRaw);
  if (teamId) {
    const pid = pickByGames(byKey.get(`${pn.surname}|${pn.initial}|${season}|${teamId}`));
    if (pid) { stats.matched++; return pid; }
  }
  let pid = pickByGames(byLoose.get(`${pn.surname}|${pn.initial}|${season}`));
  if (pid) { stats.matched++; return pid; }
  // Fallback: match on the last surname segment, for an abbreviated hyphenated
  // surname (e.g. "W-Milera" ↔ "Wanganeen-Milera" — both end "milera").
  if (pn.surnameLast !== pn.surname) {
    if (teamId) {
      pid = pickByGames(byLast.get(`${pn.surnameLast}|${pn.initial}|${season}|${teamId}`));
      if (pid) { stats.matched++; return pid; }
    }
    pid = pickByGames(byLastLoose.get(`${pn.surnameLast}|${pn.initial}|${season}`));
    if (pid) { stats.matched++; return pid; }
  }
  stats.unmatched++;
  return null;
}

/* ----------------------------- accumulate ------------------------------- */
const honours = {}; // personId -> { brownlow, allAustralian, risingStar, coaches }
const bucket = (pid, key) => {
  if (!honours[pid]) honours[pid] = {};
  if (!honours[pid][key]) honours[pid][key] = [];
  return honours[pid][key];
};

const brownlowRows = readCSV('honours_brownlow.csv');
// Per season: whether the source flagged a winner (" W" suffix) and the top
// tally. The source misses some winners (e.g. 2020 has no " W"), so for those
// seasons we treat the top vote-getter as the winner. The explicit flag stays
// authoritative where present — it handles the rare medallist-wasn't-top cases.
const blSeason = {};
for (const r of brownlowRows) {
  const s = parseInt(r.season, 10);
  const v = Math.round(parseFloat(r.votes) || 0);
  if (!blSeason[s]) blSeason[s] = { hasW: false, max: 0 };
  if (/\sW\s*$/.test(r.player)) blSeason[s].hasW = true;
  if (v > blSeason[s].max) blSeason[s].max = v;
}
for (const r of brownlowRows) {
  const season = parseInt(r.season, 10);
  const pid = matchPerson(r.player, season, r.team);
  if (!pid) continue;
  const votes = Math.round(parseFloat(r.votes) || 0);
  const info = blSeason[season];
  const won = /\sW\s*$/.test(r.player) || (!info.hasW && votes > 0 && votes === info.max);
  bucket(pid, 'brownlow').push(won ? { y: season, v: votes, w: true } : { y: season, v: votes });
}

for (const r of readCSV('honours_aa.csv')) {
  const season = parseInt(r.season, 10);
  const pid = matchPerson(r.player, season, r.team);
  if (!pid) continue;
  const arr = bucket(pid, 'allAustralian');
  if (!arr.includes(season)) arr.push(season);
}

for (const r of readCSV('honours_rising.csv')) {
  const season = parseInt(r.season, 10);
  const pid = matchPerson(r.player, season, r.team);
  if (!pid) continue;
  bucket(pid, 'risingStar').push({ y: season });
}

// Per-round coaches votes (recent seasons) → attach to the season entry so the
// app can render a per-game "CV" column in the game log. Sparse: polled rounds only.
// The AFLCA feed labels the Opening Round (2024+) as round 1, but our game logs
// label it 0 — a +1 offset. Detect per season from a round-0 game so the CV map
// keys line up with the game-log rounds the app renders.
const seasonOffset = new Map(); // season -> 0|1
{
  const minRound = new Map();
  for (const p of players) {
    if (!Array.isArray(p.gameLog)) continue;
    for (const g of p.gameLog) {
      if (typeof g.round !== 'number') continue;
      const cur = minRound.get(p.season);
      if (cur === undefined || g.round < cur) minRound.set(p.season, g.round);
    }
  }
  for (const [s, mn] of minRound) seasonOffset.set(s, mn === 0 ? 1 : 0);
}
const coachRounds = new Map(); // `${pid}|${season}` -> { [gamelogRound]: votes }
for (const r of readCSV('coaches_rounds.csv')) {
  const season = parseInt(r.season, 10);
  const feedRound = parseInt(r.round, 10);
  const votes = Math.round(parseFloat(r.votes) || 0);
  if (!Number.isFinite(feedRound) || votes <= 0) continue;
  const m = String(r.player).match(/\(([^)]+)\)/);
  const pid = matchPerson(r.player, season, m ? m[1] : '');
  if (!pid) continue;
  const round = feedRound - (seasonOffset.get(season) ?? 0); // → game-log numbering
  const key = `${pid}|${season}`;
  let rr = coachRounds.get(key);
  if (!rr) coachRounds.set(key, (rr = {}));
  rr[round] = votes;
}
for (const r of readCSV('honours_coaches.csv')) {
  const season = parseInt(r.season, 10);
  const m = String(r.player).match(/\(([^)]+)\)/); // team abbrev inside the name
  const pid = matchPerson(r.player, season, m ? m[1] : '');
  if (!pid) continue;
  const entry = { y: season, v: Math.round(parseFloat(r.votes) || 0) };
  const rr = coachRounds.get(`${pid}|${season}`);
  if (rr && Object.keys(rr).length) entry.rounds = rr;
  bucket(pid, 'coaches').push(entry);
}

// Sort each person's lists newest-first.
for (const pid of Object.keys(honours)) {
  const h = honours[pid];
  if (h.brownlow) h.brownlow.sort((a, b) => b.y - a.y);
  if (h.allAustralian) h.allAustralian.sort((a, b) => b - a);
  if (h.risingStar) h.risingStar.sort((a, b) => b.y - a.y);
  if (h.coaches) h.coaches.sort((a, b) => b.y - a.y);
}

writeFileSync(OUT, JSON.stringify({ season: new Date().getFullYear(), honours }));
console.log(
  `Honours: ${Object.keys(honours).length} players with honours ` +
    `(${stats.matched} rows matched, ${stats.resolved} name-clashes resolved by games, ${stats.unmatched} unmatched)`
);
