// Builds the EXPENSIVE, season-stable part of the awards — the projected
// All-Australian teams (full + rating views) + per-player selection odds from a
// 2000-run Monte-Carlo — so the app skips that ~10s cost. The cheap, game-live
// parts (Brownlow per-game tally, coaches) stay computed ON-DEVICE so they update
// in-round; this file deliberately does NOT compute them.
//
//   node scripts/afl/build-awards.mjs --players players.json --weights weights.json \
//        --honours honours.json [--games games.json] [--out awards.json]
//
// Output: { version, aa: { full, rating }, aaProb, aaBreakdown } — version matches
// players.json so the app only trusts it against the exact dataset it loaded.
//
// Self-contained (Node 20+): the rating math is a 1:1 port of rating.ts, the
// positional solver of positionalTeam.ts, the merit/Monte-Carlo of awards.ts.
// Radar metrics + lower-is-better come from the committed rating-config.json.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const PLAYERS = arg('--players', 'players.json');
const WEIGHTS = arg('--weights', 'weights.json');
const HONOURS = arg('--honours', 'honours.json');
const GAMES = arg('--games', null);
const OUT = arg('--out', 'awards.json');

const CFG = JSON.parse(readFileSync(new URL('./rating-config.json', import.meta.url), 'utf8'));
const ROLE_METRICS = CFG.roleMetrics;
const LOWER = new Set(CFG.lowerIsBetter);

// ---- rating (port of rating.ts) -------------------------------------------
const Z_CAP = 3;
const RATING_MID = 50;
const RATING_HI = 87;
const RATING_HI_Q = 0.95;

function zStatsFromPool(pool, metrics) {
  const out = {};
  for (const m of metrics) {
    let n = 0, sum = 0, sq = 0;
    for (const p of pool) {
      const v = p.stats[m];
      if (typeof v === 'number' && Number.isFinite(v)) { n++; sum += v; sq += v * v; }
    }
    const mean = n ? sum / n : 0;
    const variance = n ? Math.max(0, sq / n - mean * mean) : 1;
    out[m] = { mean, std: Math.sqrt(variance) };
  }
  return out;
}

function zComposite(metrics, stats, zstats, w) {
  let num = 0, den = 0;
  for (let i = 0; i < metrics.length; i++) {
    const m = metrics[i];
    const raw = stats[m];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const st = zstats[m];
    if (!st || st.std <= 1e-9) continue;
    let z = (raw - st.mean) / st.std;
    if (z > Z_CAP) z = Z_CAP; else if (z < -Z_CAP) z = -Z_CAP;
    if (LOWER.has(m)) z = -z;
    const wi = w ? w[i] : 1;
    num += wi * z; den += wi;
  }
  return den ? num / den : null;
}

function scaleComposite(comp, sortedPool) {
  const n = sortedPool.length;
  if (!n) return 0;
  const med = sortedPool[Math.floor(0.5 * n)];
  const hi = sortedPool[Math.min(n - 1, Math.floor(RATING_HI_Q * n))];
  const span = hi - med;
  const slope = span > 1e-9 ? (RATING_HI - RATING_MID) / span : 0;
  return Math.max(0, Math.min(100, Math.round(RATING_MID + slope * (comp - med))));
}

// ---- positional solver (port of positionalTeam.ts) ------------------------
const LINE_OF = {
  KEY_DEFENDER: 'DEF', REBOUND_DEFENDER: 'DEF', MIDFIELDER: 'MID', WING: 'MID',
  RUCK: 'RUCK', KEY_FORWARD: 'FWD', SMALL_FORWARD: 'FWD',
};
const LINE_ORDER = ['DEF', 'MID', 'RUCK', 'FWD'];
const LINE_LABEL = { DEF: 'Defenders', MID: 'Midfielders', RUCK: 'Ruck', FWD: 'Forwards', BENCH: 'Interchange' };

function fillLine(arr, seats, mk, meritOf) {
  const sorted = [...arr].sort((a, b) => meritOf(b) - meritOf(a));
  let pick = sorted.slice(0, seats);
  if (mk) {
    const have = pick.filter((c) => c.role === mk.role).length;
    if (have < mk.min) {
      const extra = sorted.filter((c) => c.role === mk.role && !pick.includes(c)).slice(0, mk.min - have);
      if (extra.length) {
        const drop = new Set(
          pick.filter((c) => c.role !== mk.role).sort((a, b) => meritOf(a) - meritOf(b)).slice(0, extra.length),
        );
        pick = pick.filter((c) => !drop.has(c)).concat(extra);
      }
    }
  }
  return pick.sort((a, b) => meritOf(b) - meritOf(a));
}

function selectPositionalTeam(cands, cfg, meritOf = (c) => c.merit) {
  const byLine = { DEF: [], MID: [], RUCK: [], FWD: [] };
  for (const c of cands) byLine[c.line].push(c);
  const seated = {};
  const chosen = new Set();
  for (const line of ['RUCK', 'MID', 'FWD', 'DEF']) {
    let pick = fillLine(byLine[line], cfg.seats[line], cfg.minKey?.[line], meritOf);
    const fx = cfg.flex?.[line];
    if (fx) {
      const mk = cfg.minKey?.[line];
      const overflow = [...byLine[fx.fromLine]]
        .filter((c) => !chosen.has(c.id) && !pick.includes(c))
        .sort((a, b) => meritOf(b) - meritOf(a));
      let used = 0;
      for (const cand of overflow) {
        if (used >= fx.max) break;
        if (fx.gate && !fx.gate(cand)) continue;
        const weakest = pick.filter((c) => !(mk && c.role === mk.role)).sort((a, b) => meritOf(a) - meritOf(b))[0];
        if (!weakest || meritOf(cand) <= meritOf(weakest)) break;
        pick = pick.filter((c) => c !== weakest).concat(cand).sort((a, b) => meritOf(b) - meritOf(a));
        chosen.add(cand.id);
        used++;
      }
    }
    seated[line] = pick;
    for (const c of pick) chosen.add(c.id);
  }
  const roleCount = {};
  for (const line of LINE_ORDER) for (const c of seated[line]) roleCount[c.role] = (roleCount[c.role] ?? 0) + 1;
  const bench = [];
  for (const c of cands.filter((c) => !chosen.has(c.id)).sort((a, b) => meritOf(b) - meritOf(a))) {
    if (bench.length >= cfg.bench) break;
    const cap = cfg.roleCap?.[c.role];
    if (cap != null && (roleCount[c.role] ?? 0) >= cap) continue;
    bench.push(c);
    roleCount[c.role] = (roleCount[c.role] ?? 0) + 1;
  }
  for (const c of bench) chosen.add(c.id);
  return { seated, bench, chosen };
}

// ---- AA merits + selection (port of awards.ts) ----------------------------
const AA_CONFIG = {
  seats: { DEF: 6, MID: 5, RUCK: 1, FWD: 6 },
  bench: 4,
  minKey: { DEF: { role: 'KEY_DEFENDER', min: 2 }, FWD: { role: 'KEY_FORWARD', min: 2 } },
  flex: {
    DEF: { fromLine: 'MID', max: 1, gate: (c) => (c.reb ?? 0) >= 1.8 },
    FWD: { fromLine: 'MID', max: 1, gate: (c) => (c.score ?? 0) >= 1.0 },
  },
  roleCap: { RUCK: 2 },
};
const AA_SIGMA = 0.8;
const AA_SIMS = 2000;
const IN_MIX = 3;
const AA_FEATURE_W = { rating: 0.921, win: 0.147, games: 0.562, coaches: 1.14 };
const AA_FEATURE_LABELS = ['Kickpoint rating', 'Team success', 'Games played', 'Coaches votes'];

const halfSeasonGames = (players) => Math.ceil(players.reduce((mx, p) => Math.max(mx, p.games), 0) / 2);

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function winRateByTeam(games) {
  const w = {}, n = {};
  for (const g of games) {
    if (g.complete !== 100 || g.hscore == null || g.ascore == null) continue;
    const h = String(g.hteamid), a = String(g.ateamid);
    n[h] = (n[h] ?? 0) + 1; n[a] = (n[a] ?? 0) + 1;
    const d = g.hscore - g.ascore;
    w[h] = (w[h] ?? 0) + (d > 0 ? 1 : d === 0 ? 0.5 : 0);
    w[a] = (w[a] ?? 0) + (d < 0 ? 1 : d === 0 ? 0.5 : 0);
  }
  const out = {};
  for (const t of Object.keys(n)) out[t] = n[t] ? w[t] / n[t] : 0.5;
  return out;
}

function sortedFrac(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
  return sorted.length ? lo / sorted.length : 0;
}

function aaMerits(players, ratingById, winRate, coaches) {
  const minGames = Math.max(1, halfSeasonGames(players));
  const pool = players.filter((p) => p.games >= minGames && LINE_OF[p.role]);
  const featOf = (p) => [ratingById[p.id] ?? 0, (winRate[p.teamId] ?? 0.5) - 0.5, p.games, coaches[p.id] ?? 0];
  const K = 4;
  const cols = Array.from({ length: K }, () => []);
  for (const p of pool) { const f = featOf(p); for (let j = 0; j < K; j++) cols[j].push(f[j]); }
  const n = pool.length || 1;
  const mean = cols.map((c) => c.reduce((a, b) => a + b, 0) / n);
  const sd = cols.map((c, j) => Math.sqrt(c.reduce((a, b) => a + (b - mean[j]) ** 2, 0) / n) || 1);
  const sortedCols = cols.map((c) => [...c].sort((a, b) => a - b));
  const W = [AA_FEATURE_W.rating, AA_FEATURE_W.win, AA_FEATURE_W.games, AA_FEATURE_W.coaches];
  const fmtFeat = (j, p) =>
    j === 0 ? String(ratingById[p.id] ?? 0)
    : j === 1 ? `${Math.round((winRate[p.teamId] ?? 0.5) * 100)}%`
    : j === 2 ? String(p.games)
    : String(coaches[p.id] ?? 0);
  const full = {}, rating = {}, breakdown = {};
  for (const p of pool) {
    const f = featOf(p);
    const z = f.map((v, j) => (v - mean[j]) / sd[j]);
    full[p.id] = z.reduce((a, zj, j) => a + W[j] * zj, 0);
    rating[p.id] = W[0] * z[0];
    breakdown[p.id] = f.map((v, j) => ({
      key: AA_FEATURE_LABELS[j], label: AA_FEATURE_LABELS[j], valueStr: fmtFeat(j, p),
      percentile: Math.round(sortedFrac(sortedCols[j], v) * 100), contribution: W[j] * z[j],
    })).sort((a, b) => b.contribution - a.contribution);
  }
  return { full, rating, breakdown };
}

function selectAllAustralian(players, meritById) {
  const minGames = Math.max(1, halfSeasonGames(players));
  const cands = [];
  for (const p of players) {
    if (p.games < minGames || !LINE_OF[p.role]) continue;
    cands.push({ id: p.id, role: p.role, line: LINE_OF[p.role], merit: meritById[p.id] ?? 0, score: p.stats.goals ?? 0, reb: p.stats.rebound50s ?? 0 });
  }
  const byLine = { DEF: [], MID: [], RUCK: [], FWD: [] };
  for (const c of cands) byLine[c.line].push(c);
  const aaProb = {};
  for (const c of cands) aaProb[c.id] = 0;
  for (let s = 0; s < AA_SIMS; s++) {
    const noise = new Map();
    for (const c of cands) noise.set(c.id, c.merit + AA_SIGMA * gauss());
    const { chosen } = selectPositionalTeam(cands, AA_CONFIG, (c) => noise.get(c.id));
    for (const id of chosen) aaProb[id] += 1;
  }
  for (const id of Object.keys(aaProb)) aaProb[id] /= AA_SIMS;
  const det = selectPositionalTeam(cands, AA_CONFIG);
  const byMerit = (a, b) => b.merit - a.merit;
  const aaTeam = LINE_ORDER.map((line) => ({
    key: line, label: LINE_LABEL[line], seats: AA_CONFIG.seats[line],
    selected: det.seated[line].map((c) => c.id),
    inMix: byLine[line].filter((c) => !det.chosen.has(c.id)).sort(byMerit).slice(0, IN_MIX).map((c) => c.id),
  }));
  aaTeam.push({
    key: 'BENCH', label: LINE_LABEL.BENCH, seats: AA_CONFIG.bench,
    selected: det.bench.map((c) => c.id),
    inMix: cands.filter((c) => !det.chosen.has(c.id)).sort(byMerit).slice(0, IN_MIX).map((c) => c.id),
  });
  return { aaProb, aaTeam };
}

export { selectPositionalTeam, aaMerits, selectAllAustralian, winRateByTeam, zStatsFromPool, zComposite, scaleComposite, AA_CONFIG, LINE_OF };

// ---- run ------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
const playersRaw = readFileSync(PLAYERS, 'utf8');
const playersDoc = JSON.parse(playersRaw);
const players = playersDoc.players ?? playersDoc;
const version = playersDoc.version ?? createHash('sha256').update(playersRaw).digest('hex').slice(0, 16);
const weights = (JSON.parse(readFileSync(WEIGHTS, 'utf8')).weights) ?? {};
const honours = (JSON.parse(readFileSync(HONOURS, 'utf8')).honours) ?? {};
let games = [];
if (GAMES) {
  try { const g = JSON.parse(readFileSync(GAMES, 'utf8')); games = g.games ?? g ?? []; }
  catch { games = []; }
}

const season = players.reduce((mx, p) => Math.max(mx, p.season || 0), 0);
const current = players.filter((p) => p.season === season && !p.historical);

// Rate every current player against its role's all-seasons pool (rating.ts).
const byRole = {};
for (const p of players) if (!p.historical && p.role) (byRole[p.role] ??= []).push(p);
const ratingById = {};
const zsByRole = {}, compPoolByRole = {};
for (const role of Object.keys(byRole)) {
  const metrics = ROLE_METRICS[role];
  if (!metrics) continue;
  const zs = zStatsFromPool(byRole[role], metrics);
  const w = weights[role];
  const comps = [];
  for (const p of byRole[role]) { const c = zComposite(metrics, p.stats, zs, w); if (c != null) comps.push(c); }
  comps.sort((a, b) => a - b);
  zsByRole[role] = zs; compPoolByRole[role] = comps;
}
for (const p of current) {
  const metrics = ROLE_METRICS[p.role];
  if (!metrics) { ratingById[p.id] = null; continue; }
  const comp = zComposite(metrics, p.stats, zsByRole[p.role], weights[p.role]);
  ratingById[p.id] = comp == null || !compPoolByRole[p.role].length ? null : scaleComposite(comp, compPoolByRole[p.role]);
}

const winRate = winRateByTeam(games);
const coaches = {};
for (const p of current) {
  const v = honours[String(p.personId)]?.coaches?.find((c) => c.y === season)?.v;
  if (typeof v === 'number' && v > 0) coaches[p.id] = v;
}

const { full, rating, breakdown } = aaMerits(current, ratingById, winRate, coaches);
const fullView = selectAllAustralian(current, full);
const ratingView = selectAllAustralian(current, rating);
const aa = {
  full: { team: fullView.aaTeam, prob: fullView.aaProb },
  rating: { team: ratingView.aaTeam, prob: ratingView.aaProb },
};

writeFileSync(OUT, JSON.stringify({ version, aa, aaProb: fullView.aaProb, aaBreakdown: breakdown }) + '\n');

const named = (ids) => ids.map((id) => current.find((p) => p.id === id)?.name ?? id);
const defs = fullView.aaTeam.find((g) => g.key === 'DEF');
const mids = fullView.aaTeam.find((g) => g.key === 'MID');
const fwds = fullView.aaTeam.find((g) => g.key === 'FWD');
console.log(`build-awards: season ${season}, version ${version}, ${current.length} current players, ${games.length} games`);
console.log(`  DEF: ${named(defs.selected).join(', ')}`);
console.log(`  MID: ${named(mids.selected).join(', ')}`);
console.log(`  FWD: ${named(fwds.selected).join(', ')}`);
}
