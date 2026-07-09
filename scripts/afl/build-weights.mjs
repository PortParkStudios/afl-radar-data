// Builds weights.json (per-role rating weights) from players.json + honours.json,
// so the app never runs the 7 on-device logistic fits. Self-contained (Node only)
// so it runs in the data-repo Action. The math is a 1:1 port of the app's
// ratingWeights.ts; the hyperparameters, priors and radar metrics come from the
// committed rating-config.json (generated from the app's TS by gen-rating-config).
//
//   node scripts/afl/build-weights.mjs [--players players.json] [--honours honours.json] [--out weights.json]
//
// Output: { version, builtFromPlayersVersion, weights: { ROLE: number[] } }
// `version` matches the players.json it was built from, so the app only trusts
// these weights when they line up with the dataset it loaded.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PLAYERS = arg('--players', 'players.json');
const HONOURS = arg('--honours', 'honours.json');
const OUT = arg('--out', 'weights.json');

const CFG = JSON.parse(readFileSync(new URL('./rating-config.json', import.meta.url), 'utf8'));
const { SHRINK, RIDGE, ITERS, LR, MIN_POSITIVES, MIN_POOL, SHARPEN, BLEND, FLOOR, CAP } = CFG.hyperparams;
const LOWER = new Set(CFG.lowerIsBetter);

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Fraction of a pre-sorted pool that is <= v (percentile-rank convention). */
function fracLE(sorted, v) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length ? lo / sorted.length : 0;
}

/** Balanced-class L2 logistic regression by gradient descent → [b0, ...bk]. */
function fitLogistic(X, y, w) {
  const n = X.length;
  const k = n ? X[0].length : 0;
  const beta = new Array(k + 1).fill(0);
  const W = w.reduce((a, b) => a + b, 0) || 1;
  for (let it = 0; it < ITERS; it++) {
    const g = new Array(k + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let z = beta[0];
      for (let j = 0; j < k; j++) z += beta[j + 1] * X[i][j];
      const err = (sigmoid(z) - y[i]) * w[i];
      g[0] += err;
      for (let j = 0; j < k; j++) g[j + 1] += err * X[i][j];
    }
    beta[0] -= LR * (g[0] / W);
    for (let j = 0; j < k; j++) beta[j + 1] -= LR * (g[j + 1] / W + RIDGE * beta[j + 1]);
  }
  return beta;
}

function fitBeta(X, y) {
  if (X.length === 0) return null;
  const pos = y.reduce((a, b) => a + b, 0);
  if (pos < MIN_POSITIVES || pos === y.length) return null;
  const negW = (y.length - pos) / pos;
  return fitLogistic(X, y, y.map((v) => (v ? negW : 1)));
}

function weightsFromBeta(beta, k) {
  const equal = new Array(k).fill(k ? 1 / k : 0);
  if (!beta) return equal;
  const raw = beta.slice(1).map((b) => Math.max(0, b));
  const sum = raw.reduce((a, b) => a + b, 0);
  const learned = sum > 0 ? raw.map((b) => b / sum) : equal;
  return learned.map((lw, i) => SHRINK * lw + (1 - SHRINK) * equal[i]);
}

function blendWithPrior(role, metrics, learned) {
  const sharp = learned.map((w) => Math.pow(w, SHARPEN));
  const s = sharp.reduce((a, b) => a + b, 0) || 1;
  const priorsForRole = CFG.priors[role] || {};
  const prior = metrics.map((m) => (priorsForRole[m] ?? 0) / 100);
  let out = sharp.map((w, i) => (BLEND * w) / s + (1 - BLEND) * prior[i]);
  for (let it = 0; it < 20; it++) {
    out = out.map((x) => Math.min(CAP, Math.max(FLOOR, x)));
    const t = out.reduce((a, b) => a + b, 0);
    if (Math.abs(t - 1) < 1e-6) break;
    out = out.map((x) => x / t);
  }
  return out.map((x) => Math.min(CAP, Math.max(FLOOR, x)));
}

function fitRoleModel(role, pool, honours) {
  const metrics = CFG.roleMetrics[role];
  const sorted = metrics.map((m) => {
    const vals = [];
    for (const p of pool) {
      const v = p.stats[m];
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    return vals;
  });
  if (pool.length < MIN_POOL) return { beta: null, metrics };
  const X = [];
  const y = [];
  for (const p of pool) {
    X.push(
      metrics.map((m, j) => {
        const v = p.stats[m];
        const raw = typeof v === 'number' && Number.isFinite(v) ? fracLE(sorted[j], v) : 0;
        return LOWER.has(m) ? 1 - raw : raw;
      }),
    );
    const aa = honours[String(p.personId)]?.allAustralian;
    y.push(Array.isArray(aa) && aa.includes(p.season) ? 1 : 0);
  }
  return { beta: fitBeta(X, y), metrics };
}

function fitAll(playersByRole, honours) {
  const weights = {};
  for (const role of CFG.roleOrder) {
    const pool = playersByRole[role] ?? [];
    const m = fitRoleModel(role, pool, honours);
    const baked = CFG.coachesLearnedDef[role];
    const learned = baked && baked.length === m.metrics.length ? baked : weightsFromBeta(m.beta, m.metrics.length);
    weights[role] = blendWithPrior(role, m.metrics, learned);
  }
  return weights;
}

// ---- run ----
const playersRaw = readFileSync(PLAYERS, 'utf8');
const playersDoc = JSON.parse(playersRaw);
const players = playersDoc.players ?? playersDoc;
const honoursDoc = JSON.parse(readFileSync(HONOURS, 'utf8'));
const honours = honoursDoc.honours ?? honoursDoc;

const byRole = {};
for (const p of players) {
  if (!p || !p.role || !p.stats) continue;
  (byRole[p.role] ??= []).push(p);
}

const weights = fitAll(byRole, honours);
const version = playersDoc.version ?? createHash('sha256').update(playersRaw).digest('hex').slice(0, 16);
writeFileSync(OUT, JSON.stringify({ version, builtFromPlayersVersion: playersDoc.version ?? null, weights }, null, 2) + '\n');

const roles = Object.keys(weights);
console.log(`build-weights: ${roles.length} roles, version ${version}`);
for (const r of roles) {
  const w = weights[r];
  const sum = w.reduce((a, b) => a + b, 0);
  console.log(`  ${r.padEnd(17)} sum=${sum.toFixed(3)} n=${w.length}`);
}
