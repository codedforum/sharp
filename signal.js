// Sharp · odds-movement signal engine (deterministic, pure, unit-testable).
// Input: a time-ordered series of match-odds snapshots for one fixture, each
//   { ts, home, draw, away }  (decimal odds; draw optional for 2-way markets).
// Output: a 0-100 conviction score + verdict on which outcome the market is
//   "steaming" toward, built from de-vigged implied probabilities. The thesis:
//   sharp money shows up as a sustained, low-noise, high-velocity move in the
//   no-vig probability of an outcome. We quantify direction/velocity/steam/magnitude.
'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (x, d = 2) => { const p = 10 ** d; return Math.round((Number(x) || 0) * p) / p; };
// map an unbounded ratio to 0..100 (50 = neutral) via tanh, like the SoSoFlows engine
const score100 = (r) => clamp(50 + 50 * Math.tanh(r), 0, 100);

// decimal odds -> implied prob, then strip the bookmaker overround (vig) so the
// three outcome probabilities sum to 1. This is the honest market estimate.
function devig(snap) {
  const raw = {};
  for (const k of ['home', 'draw', 'away']) {
    const o = Number(snap[k]);
    if (o && o > 1) raw[k] = 1 / o;
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  if (!sum) return null;
  const p = {};
  for (const k of Object.keys(raw)) p[k] = raw[k] / sum; // normalise out the vig
  return { p, overround: round((sum - 1) * 100, 2) }; // overround% = book margin
}

// per-outcome series of de-vigged probabilities
function probSeries(snaps) {
  const out = { home: [], draw: [], away: [], ts: [] };
  for (const s of snaps) {
    const d = devig(s);
    if (!d) continue;
    out.ts.push(s.ts);
    for (const k of ['home', 'draw', 'away']) out[k].push(d.p[k] != null ? d.p[k] : null);
  }
  return out;
}

function stdev(a) {
  const v = a.filter((x) => x != null);
  if (v.length < 2) return 0;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
}

// Score one outcome's probability path. baselineN = samples back to anchor "open".
function scoreOutcome(series, baselineN = 12) {
  const p = series.filter((x) => x != null);
  if (p.length < 4) return null;
  const now = p[p.length - 1];
  const base = p[Math.max(0, p.length - 1 - baselineN)];
  const move = now - base;                              // total shift in prob since baseline

  // step deltas
  const d = [];
  for (let i = 1; i < p.length; i++) d.push(p[i] - p[i - 1]);
  const recent = d.slice(-baselineN);
  const up = recent.filter((x) => x > 0).length;
  const dn = recent.filter((x) => x < 0).length;
  const consistency = recent.length ? Math.abs(up - dn) / recent.length : 0; // 0..1, directional purity (steam)
  const velocity = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const noise = stdev(recent) || 1e-6;
  const signalToNoise = velocity / noise;              // sustained drift vs chop
  const magnitude = move / (stdev(p) || 1e-6);         // move sized vs the path's own volatility

  // 0..100 sub-scores (50 neutral). Positive => probability rising (market backing this outcome).
  const factors = {
    direction: round(score100(move * 14)),             // size+sign of the repricing
    velocity: round(score100(velocity * 220)),         // how fast it is moving now
    steam: round(50 + 50 * consistency * Math.sign(velocity || move)), // directional purity
    magnitude: round(score100(magnitude * 0.7)),       // move vs its own noise floor
    conviction_snr: round(score100(signalToNoise * 0.5)),
  };
  // weighted blend (mirrors the SoSoFlows weighting philosophy)
  const score = round(0.34 * factors.direction + 0.22 * factors.velocity + 0.20 * factors.steam + 0.14 * factors.magnitude + 0.10 * factors.conviction_snr);
  return {
    score,
    factors,
    stats: {
      prob_now: round(now, 4), prob_open: round(base, 4),
      move_pct: round(move * 100, 2), velocity_bp: round(velocity * 1e4, 1),
      steam: round(consistency, 2), samples: p.length,
    },
  };
}

// Main: given a fixture's odds snapshots, return the sharp-money read.
function computeSignal(snaps, opts = {}) {
  const baselineN = opts.baselineN || 12;
  if (!Array.isArray(snaps) || snaps.length < 4) return { verdict: 'WATCH', score: 50, note: 'insufficient history' };
  const ser = probSeries(snaps);
  const per = {};
  for (const k of ['home', 'draw', 'away']) {
    const r = scoreOutcome(ser[k], baselineN);
    if (r) per[k] = r;
  }
  const ranked = Object.entries(per).sort((a, b) => b[1].score - a[1].score);
  if (!ranked.length) return { verdict: 'WATCH', score: 50, note: 'no scorable outcome' };
  const [topK, top] = ranked[0];
  const last = devig(snaps[snaps.length - 1]);
  // a "STEAM" call requires both a strong score and genuine directional purity
  const steaming = top.score >= 66 && top.stats.steam >= 0.5 && top.stats.move_pct > 0;
  const drifting = top.score <= 34;
  const verdict = steaming ? 'STEAM' : drifting ? 'DRIFT' : 'LEAN';
  return {
    verdict,                       // STEAM (sharp backing) / LEAN / DRIFT / WATCH
    side: topK.toUpperCase(),      // HOME / DRAW / AWAY the market is moving toward
    score: top.score,              // conviction 0..100
    confidence: round(Math.abs(top.score - 50) * 2),
    factors: top.factors,
    stats: top.stats,
    market: last ? { overround_pct: last.overround, implied: { home: round(last.p.home, 3), draw: last.p.draw != null ? round(last.p.draw, 3) : null, away: round(last.p.away, 3) } } : null,
    per_outcome: Object.fromEntries(ranked.map(([k, v]) => [k, v.score])),
  };
}

module.exports = { computeSignal, devig, probSeries, scoreOutcome };

// ---- self-test with a synthetic "steam toward HOME" series (no live data needed) ----
if (require.main === module) {
  const snaps = [];
  let home = 2.60, away = 2.80, draw = 3.30;
  for (let i = 0; i < 20; i++) {
    // simulate sharp money steadily shortening HOME (odds drift down), lengthening AWAY
    home -= 0.035 + Math.random() * 0.004;
    away += 0.03 + Math.random() * 0.004;
    draw += (Math.random() - 0.5) * 0.02;
    snaps.push({ ts: i * 60, home: +home.toFixed(2), draw: +draw.toFixed(2), away: +away.toFixed(2) });
  }
  const sig = computeSignal(snaps);
  console.log(JSON.stringify(sig, null, 2));
  console.log('\nexpect: verdict STEAM, side HOME, score high, steam ~1.0 ->', sig.verdict, sig.side, sig.score);
}
